import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { addFlight, addFlightInputSchema } from "../../src/tools/add-flight.ts";
import type { FlightStop } from "../../src/types.ts";
import type { TripPlan } from "../../src/types.ts";

const tpe = {
  iata: "TPE",
  name: "Taiwan Taoyuan International Airport",
  cityName: "Taipei",
  googlePlace: {
    name: "Taiwan Taoyuan International Airport",
    place_id: "ChIJ_tpe",
    utc_offset: 480,
  },
};
const axt = {
  iata: "AXT",
  name: "Akita Airport",
  cityName: "Akita",
  googlePlace: { name: "Akita Airport", place_id: "ChIJ_axt" },
};
const oka = {
  iata: "OKA",
  name: "Naha Airport",
  cityName: "Naha",
  googlePlace: { place_id: "ChIJ_oka" },
};
const hnd = {
  iata: "HND",
  name: "Haneda Airport",
  cityName: "Tokyo",
  googlePlace: { place_id: "ChIJ_hnd" },
};

const it256: FlightStop = {
  depart: { type: "depart", date: "2026-12-17", time: "08:30", airport: tpe },
  arrive: { type: "arrive", date: "2026-12-17", time: "12:40", airport: axt },
};
const twoLegs: FlightStop[] = [
  {
    depart: { type: "depart", date: "2026-12-20", time: "07:15", airport: tpe },
    arrive: { type: "arrive", date: "2026-12-20", time: "09:50", airport: oka },
  },
  {
    depart: { type: "depart", date: "2026-12-20", time: "11:05", airport: oka },
    arrive: { type: "arrive", date: "2026-12-20", time: "13:35", airport: hnd },
  },
];

const AIRLINES = [
  { iata: "IT", icao: "TTW", name: "Tigerair Taiwan", localizedName: "Tigerair Taiwan" },
  { iata: "JX", icao: "SJX", name: "STARLUX Airlines", localizedName: "STARLUX Airlines" },
  { iata: "NH", icao: "ANA", name: "ANA (All Nippon Airways)", localizedName: "ANA" },
];

function trip(withFlightsSection: boolean, existingFlights: unknown[] = []): TripPlan {
  const sections: unknown[] = [
    { id: 11, type: "textOnly", mode: "placeList", heading: "Notes", date: null, blocks: [] },
  ];
  if (withFlightsSection) {
    sections.push({
      id: 22,
      type: "flights",
      mode: "placeList",
      heading: "Flights",
      date: null,
      blocks: existingFlights,
      placeMarkerColor: "#3498db",
      placeMarkerIcon: "plane",
      text: { ops: [{ insert: "\n" }] },
    });
  }
  sections.push({
    id: 33,
    type: "normal",
    mode: "placeList",
    heading: "Places to visit",
    date: null,
    blocks: [],
  });
  return { title: "青森冬季自駕", itinerary: { sections } } as unknown as TripPlan;
}

function makeFakeContext(tripPlan: TripPlan, stops: FlightStop[]) {
  const lookups: Array<{ airlineIata: string; flightNumber: number; departDate: string }> = [];
  const submittedOps: Json0Op[][] = [];
  const entry = { snapshot: structuredClone(tripPlan), version: 13, geos: [] };
  const ctx = {
    userId: 709119,
    rest: {
      getFlightStops: async (args: {
        airlineIata: string;
        flightNumber: number;
        departDate: string;
      }) => {
        lookups.push(args);
        return stops;
      },
      getAllAirlines: async () => AIRLINES,
    },
    pool: {
      get: () => ({
        isSubscribed: true,
        version: 13,
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
  return { ctx, lookups, submittedOps };
}

type Inserted = { p: unknown[]; li: Record<string, unknown> };

describe("addFlight", () => {
  it("inserts the block in the exact shape the Wanderlog web app writes", async () => {
    const { ctx, lookups, submittedOps } = makeFakeContext(trip(true), [it256]);
    const result = await addFlight(ctx, { trip_key: "T", flight: "IT256", date: "2026-12-17" });

    expect(result.isError).toBeUndefined();
    expect(lookups).toEqual([{ airlineIata: "IT", flightNumber: 256, departDate: "2026-12-17" }]);
    const op = submittedOps[0]![0] as Inserted;
    expect(op.p).toEqual(["itinerary", "sections", 1, "blocks", 0]);
    const { id, ...block } = op.li;
    expect(typeof id).toBe("number");
    expect(block).toEqual({
      type: "flight",
      flightInfo: { airline: AIRLINES[0], number: 256 },
      depart: it256.depart,
      arrive: it256.arrive,
      addedBy: { type: "user", userId: 709119 },
      text: { ops: [{ insert: "\n" }] },
      travelerNames: [],
      confirmationNumber: "",
      attachments: [],
    });
    expect(result.content[0]!.text).toContain("IT256");
    expect(result.content[0]!.text).toContain("TPE");
    expect(result.content[0]!.text).toContain("AXT");
  });

  it("accepts a spaced, lower-case flight code and appends after existing flights", async () => {
    const existing = [{ id: 5, type: "flight" }];
    const { ctx, lookups, submittedOps } = makeFakeContext(trip(true, existing), [it256]);
    await addFlight(ctx, {
      trip_key: "T",
      flight: "jx 862",
      date: "2026-12-17",
      confirmation_number: "Q7ZK2M",
      traveler_names: ["Mei Lin", "Kai Chen"],
      notes: "Terminal 1, check in by 06:30",
    });

    expect(lookups[0]).toEqual({ airlineIata: "JX", flightNumber: 862, departDate: "2026-12-17" });
    const op = submittedOps[0]![0] as Inserted;
    expect(op.p).toEqual(["itinerary", "sections", 1, "blocks", 1]);
    expect(op.li.flightInfo).toEqual({ airline: AIRLINES[1], number: 862 });
    expect(op.li.confirmationNumber).toBe("Q7ZK2M");
    expect(op.li.travelerNames).toEqual(["Mei Lin", "Kai Chen"]);
    expect(op.li.text).toEqual({ ops: [{ insert: "Terminal 1, check in by 06:30\n" }] });
  });

  it("creates the Flights section when the trip has none", async () => {
    const { ctx, submittedOps } = makeFakeContext(trip(false), [it256]);
    await addFlight(ctx, { trip_key: "T", flight: "IT256", date: "2026-12-17" });

    const op = submittedOps[0]![0] as Inserted;
    expect(op.p).toEqual(["itinerary", "sections", 2]);
    expect(op.li).toMatchObject({
      type: "flights",
      mode: "placeList",
      heading: "Flights",
      placeMarkerIcon: "plane",
      placeMarkerColor: "#3498db",
    });
    expect((op.li.blocks as Array<{ type: string }>).map((b) => b.type)).toEqual(["flight"]);
  });

  it("falls back to the bare IATA code when the airline is not in the directory", async () => {
    const { ctx, submittedOps } = makeFakeContext(trip(true), [it256]);
    await addFlight(ctx, { trip_key: "T", flight: "7G 94", date: "2026-12-17" });

    const op = submittedOps[0]![0] as Inserted;
    expect(op.li.flightInfo).toEqual({ airline: { iata: "7G" }, number: 94 });
  });

  it("returns an error and writes nothing when the flight does not fly that day", async () => {
    const { ctx, submittedOps } = makeFakeContext(trip(true), []);
    const result = await addFlight(ctx, { trip_key: "T", flight: "IT256", date: "2026-12-23" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("IT256");
    expect(result.content[0]!.text).toContain("2026-12-23");
    expect(submittedOps).toHaveLength(0);
  });

  it("asks which leg to add when a multi-leg flight is ambiguous", async () => {
    const { ctx, submittedOps } = makeFakeContext(trip(true), twoLegs);
    const result = await addFlight(ctx, { trip_key: "T", flight: "NH1234", date: "2026-12-20" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("TPE → OKA");
    expect(result.content[0]!.text).toContain("OKA → HND");
    expect(submittedOps).toHaveLength(0);
  });

  it("picks the leg matching from/to airport codes", async () => {
    const { ctx, submittedOps } = makeFakeContext(trip(true), twoLegs);
    const result = await addFlight(ctx, {
      trip_key: "T",
      flight: "NH1234",
      date: "2026-12-20",
      from: "oka",
    });

    expect(result.isError).toBeUndefined();
    const op = submittedOps[0]![0] as Inserted;
    expect(op.li.depart).toEqual(twoLegs[1]!.depart);
    expect(op.li.arrive).toEqual(twoLegs[1]!.arrive);
  });

  it("rejects malformed flight codes", () => {
    const schema = addFlightInputSchema.flight;
    expect(schema.safeParse("IT256").success).toBe(true);
    expect(schema.safeParse("jx 862").success).toBe(true);
    expect(schema.safeParse("Tigerair 256").success).toBe(false);
    expect(schema.safeParse("IT").success).toBe(false);
    expect(schema.safeParse("IT25601").success).toBe(false);
  });
});
