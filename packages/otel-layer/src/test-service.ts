import { Context } from "effect";

import type { TestInterface } from "./index.js";

export class TestService extends Context.Service<TestService, TestInterface>()(
  "@fleet-telemetry/otel-layer/Test"
) {}
