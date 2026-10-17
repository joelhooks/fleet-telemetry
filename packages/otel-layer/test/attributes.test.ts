import { describe, expect, it } from "@effect/vitest";

import {
  sanitizeAttribute,
  sanitizeAttributes,
  USAGE_COUNTER_KEYS,
} from "../src/attributes.js";
import type { DropClass } from "../src/attributes.js";

describe("attribute boundary", () => {
  it("keeps semantic attributes and the reviewed fleet set", () => {
    const reasons: DropClass[] = [];
    expect(
      sanitizeAttributes(
        Object.entries({
          "deployment.environment": "test",
          "error.type": "Unavailable",
          "fleet.error_code": "ExportUnavailable",
          "fleet.project": "project",
          "host.name": "test-host",
          "http.request.method": "POST",
          "http.response.status_code": 200,
          "rpc.system": "effect",
          "service.name": "capture-cell",
          "vcs.revision": "a".repeat(40),
        }),
        (reason) => reasons.push(reason)
      )
    ).toMatchObject({
      "fleet.project": "project",
      "http.request.method": "POST",
      "http.response.status_code": 200,
      "vcs.revision": "a".repeat(40),
    });
    expect(reasons).toEqual([]);
  });

  it("keeps only five integer usage counters; all other token fields count as secrets", () => {
    expect(USAGE_COUNTER_KEYS).toEqual([
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.total_tokens",
      "gen_ai.usage.cached_input_tokens",
      "gen_ai.usage.reasoning_tokens",
    ]);
    expect(Object.isFrozen(USAGE_COUNTER_KEYS)).toBe(true);
    const reasons: DropClass[] = [];
    for (const key of USAGE_COUNTER_KEYS) {
      expect(sanitizeAttribute(key, 12, (reason) => reasons.push(reason))).toBe(
        12
      );
      for (const value of [
        "12",
        "fixture",
        1.5,
        Number.NaN,
        Infinity,
        true,
        [12],
        { count: 12 },
      ]) {
        expect(
          sanitizeAttribute(key, value, (reason) => reasons.push(reason))
        ).toBeUndefined();
      }
    }
    for (const key of [
      "gen_ai.usage.foo_tokens",
      "gen_ai.usage.prompt_tokens",
      "fleet.input_tokens",
      "fleet.usage.total_tokens",
      "fleet.prompt_tokens",
      "http.token",
      "rpc.tokens",
      "fleet.auth_token",
      "gen_ai.input_tokens",
      "gen_ai.usage.access.token",
      "gen_ai.usage.Input_tokens",
      "HTTP.TOKEN",
    ]) {
      expect(
        sanitizeAttribute(key, 12, (reason) => reasons.push(reason))
      ).toBeUndefined();
    }
    expect(reasons.length).toBe(52);
    expect(new Set(reasons)).toEqual(new Set(["secret_key"]));
  });

  it("drops secret/content keys even below semantic prefixes", () => {
    const reasons: DropClass[] = [];
    for (const key of [
      "http.token",
      "http.api_key",
      "rpc.secret",
      "http.password",
      "http.authorization",
      "http.cookie",
      "rpc.session",
      "gen_ai.prompt",
      "http.body",
      "exception.message",
      "rpc.content",
      "service.email",
      "db.statement",
      "url.query",
      "http.request.header.x-custom",
      "url.full",
      "process.command_args",
      "fleet.unreviewed",
    ]) {
      expect(
        sanitizeAttribute(key, "fixture", (reason) => reasons.push(reason))
      ).toBeUndefined();
    }
    expect(reasons).toContain("secret_key");
    expect(reasons).toContain("content_key");
    expect(reasons).toContain("not_allowed");
  });

  it("rejects credential-shaped values including array elements before truncation", () => {
    for (const value of [
      "sk-fixture",
      "ghp_fixture",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl",
      "a".repeat(40),
      "QWxhZGRpbjpvcGVuIHNlc2FtZV9maXh0dXJlX29ubHk=",
      `safe text ${"sk-fixture"}`,
      ["safe", "ghp_fixture"],
      `fixture@${"example.test"}`,
    ]) {
      const reasons: DropClass[] = [];
      expect(
        sanitizeAttribute("http.route", value, (reason) => reasons.push(reason))
      ).toBeUndefined();
      expect(reasons.length).toBeGreaterThan(0);
    }
  });

  it("truncates plain strings; rejects nested objects, non-finite numbers and oversized arrays", () => {
    const reasons: DropClass[] = [];
    expect(
      sanitizeAttribute("http.route", "safe ".repeat(100), (reason) =>
        reasons.push(reason)
      )
    ).toHaveLength(256);
    for (const value of [
      { nested: "fixture" },
      Number.NaN,
      Infinity,
      Array.from({ length: 17 }, () => "safe"),
    ]) {
      expect(
        sanitizeAttribute("http.route", value, (reason) => reasons.push(reason))
      ).toBeUndefined();
    }
    expect(reasons).toEqual(Array.from({ length: 4 }, () => "invalid_value"));
  });
});
