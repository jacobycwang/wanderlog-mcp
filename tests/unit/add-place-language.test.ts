import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addPlace, addPlaceInputSchema } from "../../src/tools/add-place.ts";
import type { TripPlan } from "../../src/types.ts";
import { checklistTrip } from "../fixtures/checklist-trip.ts";

const NAMES_BY_LANGUAGE: Record<string, string> = {
  en: "Sensō-ji",
  ja: "浅草寺",
  "zh-TW": "淺草寺",
};

function makeFakeContext(trip: TripPlan) {
  const autocompleteLanguages: Array<string | undefined> = [];
  const detailLanguages: Array<string | undefined> = [];
  const submittedOps: Json0Op[][] = [];
  const entry = {
    snapshot: structuredClone(trip),
    version: 1,
    geos: [{ id: 86, name: "Tokyo", latitude: 35.68, longitude: 139.76 }],
  };
  const ctx = {
    userId: 3656632,
    rest: {
      searchPlacesAutocomplete: async (args: { language?: string }) => {
        autocompleteLanguages.push(args.language);
        return [{ place_id: "ChIJsensoji", description: "Sensō-ji" }];
      },
      getPlaceDetails: async (placeId: string, language?: string) => {
        detailLanguages.push(language);
        return { name: NAMES_BY_LANGUAGE[language ?? "en"], place_id: placeId };
      },
      getPlacePhotos: async () => [],
    },
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 1,
        async submit(ops: Json0Op[]) {
          submittedOps.push(ops);
        },
      }),
    },
    tripCache: {
      getEntry: async () => entry,
      applyLocalOp: (_key: string, ops: Json0Op[], version: number) => {
        entry.snapshot = applyOp(entry.snapshot, ops);
        entry.version = version;
      },
      invalidate: () => {},
    },
  } as unknown as AppContext;
  return { ctx, autocompleteLanguages, detailLanguages, submittedOps };
}

function insertedName(ops: Json0Op[]): string {
  return (ops[0] as { li: { place: { name: string } } }).li.place.name;
}

describe("addPlace language", () => {
  it("stores the Japanese name when language is 'ja'", async () => {
    const { ctx, autocompleteLanguages, detailLanguages, submittedOps } =
      makeFakeContext(checklistTrip);
    const result = await addPlace(ctx, { trip_key: "T", place: "Sensō-ji", language: "ja" });

    expect(result.isError).toBeUndefined();
    expect(autocompleteLanguages).toEqual(["ja"]);
    expect(detailLanguages).toEqual(["ja"]);
    expect(insertedName(submittedOps[0]!)).toBe("浅草寺");
    expect(result.content[0]!.text).toContain("浅草寺");
  });

  it("forwards a region-tagged language when resolving by place_id", async () => {
    const { ctx, detailLanguages, submittedOps } = makeFakeContext(checklistTrip);
    await addPlace(ctx, { trip_key: "T", place_id: "ChIJsensoji", language: "zh-TW" });

    expect(detailLanguages).toEqual(["zh-TW"]);
    expect(insertedName(submittedOps[0]!)).toBe("淺草寺");
  });

  it("keeps the existing English default when language is omitted", async () => {
    const { ctx, submittedOps } = makeFakeContext(checklistTrip);
    await addPlace(ctx, { trip_key: "T", place: "Sensō-ji" });

    expect(insertedName(submittedOps[0]!)).toBe("Sensō-ji");
  });

  it("rejects language values that are not BCP-47-shaped", () => {
    const schema = addPlaceInputSchema.language;
    expect(schema.safeParse("ja").success).toBe(true);
    expect(schema.safeParse("zh-TW").success).toBe(true);
    expect(schema.safeParse("ja&foo=bar").success).toBe(false);
    expect(schema.safeParse("Japanese").success).toBe(false);
  });
});
