import type { ForecastWeatherReading } from '../open-meteo/response';

/**
 * The seam between an ingestion cycle and whatever carries its output onward.
 *
 * ADR 0004 chose an SQS standard queue with a Lambda event source mapping, and
 * fixed the granularity: **one message per location per cycle**, carrying that
 * location's whole horizon, because ADR 0002's access pattern F1 makes a location
 * the forecast service's unit of work. That granularity is the contract this
 * interface states — one call per location-cycle — and it is the reason the method
 * takes a batch of readings rather than one.
 *
 * The transport itself is deliberately absent. Nothing in `cycle.ts` should know
 * whether a publish is a `SendMessage`, and ADR 0004 lists three concrete triggers
 * (a second consumer, an ordering requirement, a replay requirement) that would
 * change the answer without changing this call.
 *
 * Failure policy: implementations **throw**. A publish that did not happen is not
 * an outcome of this interface's domain — it is an outage of the transport
 * (`docs/standards/error-handling.md` rule 1) — and the cycle converts it into that
 * location's reported failure at its boundary, so one location's queue error can
 * never be mistaken for a delivered message.
 */
export interface WeatherPublisher {
  publishLocationReadings(readings: readonly ForecastWeatherReading[]): Promise<void>;
}
