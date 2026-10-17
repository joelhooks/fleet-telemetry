import { Effect, Schema } from "effect";

// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError is a class factory, not an Error constructor.
export class LocalResourceError extends Schema.TaggedError<LocalResourceError>()(
  "LocalResourceError",
  { cause: Schema.Defect(), operation: Schema.String }
) {}

// Node filesystem, process and download adapters terminate at this typed boundary.
export const operation = <A>(name: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new LocalResourceError({ cause, operation: name }),
    try: run,
  });
