import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestClient } from "../../src/transport/rest.ts";

describe("RestClient flight lookups", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(body: unknown) {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  const client = () =>
    new RestClient({
      cookieHeader: "connect.sid=test",
      baseUrl: "https://wanderlog.test",
      wsBaseUrl: "wss://wanderlog.test",
      userAgent: "wanderdog-test",
    });

  it("queries flightStops with airline, number, and date", async () => {
    const stop = {
      depart: { type: "depart", date: "2026-12-17", time: "08:30", airport: { iata: "TPE" } },
      arrive: { type: "arrive", date: "2026-12-17", time: "12:40", airport: { iata: "AXT" } },
    };
    respond({ success: true, data: [stop] });

    const stops = await client().getFlightStops({
      airlineIata: "IT",
      flightNumber: 256,
      departDate: "2026-12-17",
    });

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://wanderlog.test/api/flights/flightStops?airlineIata=IT&flightNumber=256&departDate=2026-12-17",
    );
    expect(stops).toEqual([stop]);
  });

  it("returns no stops when Wanderlog can't find the flight", async () => {
    respond({
      error: "ApplicationError: Sorry, we couldn't find your flight",
      success: false,
      messages: ["Sorry, we couldn't find your flight"],
      errTypes: ["requestError"],
    });

    const stops = await client().getFlightStops({
      airlineIata: "IT",
      flightNumber: 256,
      departDate: "2026-12-23",
    });

    expect(stops).toEqual([]);
  });

  it("loads the airline directory", async () => {
    const airlines = [
      { iata: "IT", icao: "TTW", name: "Tigerair Taiwan", localizedName: "Tigerair Taiwan" },
      { iata: "JX", icao: "SJX", name: "STARLUX Airlines", localizedName: "STARLUX Airlines" },
    ];
    respond({ success: true, data: airlines });

    expect(await client().getAllAirlines()).toEqual(airlines);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://wanderlog.test/api/flights/allAirlines",
    );
  });
});
