import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Airline, FlightStop } from "../types.js";
import { buildFlightBlock, requireUserId, sectionInsertOp, submitOp } from "./shared.js";

const FLIGHT_CODE = /^\s*([A-Za-z0-9]{2})\s*(\d{1,4})\s*$/;
const IATA_AIRPORT = /^[A-Za-z]{3}$/;

export const addFlightInputSchema = {
  trip_key: z.string().min(1).describe("The trip to add the flight to."),
  flight: z
    .string()
    .regex(FLIGHT_CODE, "must be an airline IATA code plus flight number, e.g. 'IT256' or 'JX 862'")
    .describe(
      "Flight code: 2-character airline IATA code + flight number, e.g. 'IT256', 'JX 862', 'BR198'.",
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Departure date (local to the departure airport), YYYY-MM-DD."),
  from: z
    .string()
    .regex(IATA_AIRPORT, "must be a 3-letter airport IATA code")
    .optional()
    .describe(
      "Optional departure airport IATA code (e.g. 'TPE'). Only needed to pick one leg of a multi-stop flight.",
    ),
  to: z
    .string()
    .regex(IATA_AIRPORT, "must be a 3-letter airport IATA code")
    .optional()
    .describe(
      "Optional arrival airport IATA code (e.g. 'AXT'). Only needed to pick one leg of a multi-stop flight.",
    ),
  confirmation_number: z.string().optional().describe("Booking/confirmation number (optional)."),
  traveler_names: z.array(z.string().min(1)).optional().describe("Traveler names (optional)."),
  notes: z.string().optional().describe("Free-text notes shown on the flight (optional)."),
};

export const addFlightDescription = `
Adds a flight to a Wanderlog trip's "Flights" section by flight number and departure date.
Wanderlog looks up the schedule, so departure/arrival airports and times are filled in
automatically — no booking needed. Use it to plan candidate flights before buying tickets.

For a multi-stop flight, pass "from" and/or "to" airport codes to choose the leg; otherwise the
tool lists the legs and asks you to pick. If Wanderlog can't find the flight on that date, check
the date (the flight may not operate that day) or the flight code.

Returns confirmation with the route and times.
`.trim();

type Args = {
  trip_key: string;
  flight: string;
  date: string;
  from?: string;
  to?: string;
  confirmation_number?: string;
  traveler_names?: string[];
  notes?: string;
};

function legLabel(stop: FlightStop): string {
  const d = stop.depart;
  const a = stop.arrive;
  return `${d.airport?.iata ?? "?"} → ${a.airport?.iata ?? "?"} (${d.date ?? ""} ${d.time ?? ""} → ${a.date ?? ""} ${a.time ?? ""})`;
}

function pickLeg(stops: FlightStop[], code: string, args: Args): FlightStop {
  const from = args.from?.toUpperCase();
  const to = args.to?.toUpperCase();
  const matches = stops.filter(
    (s) =>
      (!from || s.depart.airport?.iata?.toUpperCase() === from) &&
      (!to || s.arrive.airport?.iata?.toUpperCase() === to),
  );
  if (matches.length === 1) return matches[0]!;
  const legs = stops.map((s) => `  - ${legLabel(s)}`).join("\n");
  if (matches.length === 0) {
    throw new WanderlogValidationError(
      `${code} on ${args.date} has no leg matching${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}. Legs:\n${legs}`,
    );
  }
  throw new WanderlogValidationError(
    `${code} on ${args.date} has ${stops.length} legs. Retry with "from" and/or "to" airport codes:\n${legs}`,
  );
}

export async function addFlight(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const m = FLIGHT_CODE.exec(args.flight);
    if (!m) {
      throw new WanderlogValidationError(
        `Invalid flight "${args.flight}". Use airline IATA code + number, e.g. "IT256".`,
      );
    }
    const airlineIata = m[1]!.toUpperCase();
    const flightNumber = Number(m[2]);
    const code = `${airlineIata}${flightNumber}`;

    const userId = requireUserId(ctx);
    const [stops, airlines] = await Promise.all([
      ctx.rest.getFlightStops({ airlineIata, flightNumber, departDate: args.date }),
      ctx.rest.getAllAirlines(),
    ]);
    if (stops.length === 0) {
      throw new WanderlogError(
        `Wanderlog couldn't find flight ${code} on ${args.date}`,
        "flight_not_found",
        {
          hint: "The flight may not operate on that date, or the code is wrong. Try a nearby date or confirm the flight number.",
        },
      );
    }
    const stop = pickLeg(stops, code, args);
    const airline: Airline = airlines.find((a) => a.iata?.toUpperCase() === airlineIata) ?? {
      iata: airlineIata,
    };

    const tripTitle = await submitOp(ctx, args.trip_key, async (lockedEntry, submit) => {
      const block = buildFlightBlock(userId, {
        airline,
        flightNumber,
        stop,
        confirmationNumber: args.confirmation_number,
        travelerNames: args.traveler_names,
        notes: args.notes,
      });
      await submit([sectionInsertOp(lockedEntry.snapshot, "flights", block)]);
      return lockedEntry.snapshot.title;
    });

    const airlineName = airline.name ? ` (${airline.name})` : "";
    const text = `Added flight ${code}${airlineName} to "${tripTitle}" · ${legLabel(stop)}.`;
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
