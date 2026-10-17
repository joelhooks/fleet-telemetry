// Deliberately finite. A new fleet key requires review, not a caller override.
export const fleetAttributes = Object.freeze([
    "fleet.project",
    "fleet.muster_row",
    "fleet.ratking_name",
    "fleet.error_code",
    "fleet.operation",
    "fleet.component",
    "fleet.outcome",
    "fleet.signal",
    "fleet.drop_class",
]);
export const semanticPrefixes = Object.freeze([
    "service.",
    "host.",
    "deployment.",
    "vcs.",
    "http.",
    "url.",
    "server.",
    "client.",
    "network.",
    "db.",
    "rpc.",
    "messaging.",
    "error.",
    "exception.",
    "code.",
    "process.",
    "os.",
    "container.",
    "k8s.",
    "cloud.",
    "faas.",
    "otel.",
    "telemetry.",
    "event.",
    "thread.",
    "system.",
    "disk.",
    "cpu.",
    "memory.",
    "linux.",
    "jvm.",
    "nodejs.",
    "dotnet.",
    "go.",
    "aspnetcore.",
    "browser.",
    "webengine.",
    "device.",
    "android.",
    "ios.",
    "aws.",
    "azure.",
    "gcp.",
    "signalr.",
    "tls.",
    "dns.",
    "gen_ai.",
]);
const secretKey = /token|key|secret|password|authorization|cookie|session/iu;
// Shared with the collector. Additions require a coordinated change to both halves.
export const USAGE_COUNTER_KEYS = Object.freeze([
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.usage.cached_input_tokens",
    "gen_ai.usage.reasoning_tokens",
]);
const contentKey = /prompt|body|message|content|email|stack|statement|query|command|args|user|customer/iu;
// Prefixes are not permission to export free text, identifiers or personal data.
const sensitiveSemantic = /^(?:url\.(?:full|original|path)|http\.(?:request|response)\.header\.|(?:client|network\.peer|network\.local)\.address|code\.(?:file\.path|filepath)|process\.executable\.path|db\.operation\.parameter\.)/iu;
const jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u;
const credentialPrefix = /(?:sk-|gh[pousr]_|github_pat_|Bearer\s+|Basic\s+)/iu;
const hexRun = /[a-f0-9]{32,}/iu;
const base64Run = /[A-Za-z0-9+/_=-]{40,}/u;
const email = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const revision = /^[a-f0-9]{7,64}$/iu;
export const looksLikeCredential = (value) => jwt.test(value) ||
    credentialPrefix.test(value) ||
    hexRun.test(value) ||
    base64Run.test(value);
const stringValue = (key, value, onDrop) => {
    // A full git SHA is expected here, and nowhere else.
    if (!(key === "vcs.revision" && revision.test(value)) &&
        looksLikeCredential(value)) {
        onDrop("credential_value");
        return;
    }
    if (email.test(value)) {
        onDrop("content_key");
        return;
    }
    return value.slice(0, 256);
};
const arrayValue = (key, value, onDrop) => {
    const clean = [];
    for (const item of value) {
        if (typeof item === "string") {
            const result = stringValue(key, item, onDrop);
            if (result === undefined) {
                return;
            }
            clean.push(result);
        }
        else if (typeof item === "boolean" ||
            (typeof item === "number" && Number.isFinite(item))) {
            clean.push(item);
        }
        else {
            onDrop("invalid_value");
            return;
        }
    }
    return clean;
};
export const sanitizeAttribute = (key, value, onDrop) => {
    const validKey = key.length <= 128 && /^[a-z][a-z0-9_.-]*$/u.test(key);
    // Numeric usage is not a credential. Never coerce strings or accept arrays here.
    if (validKey &&
        USAGE_COUNTER_KEYS.includes(key) &&
        typeof value === "number" &&
        Number.isInteger(value)) {
        return value;
    }
    if (secretKey.test(key)) {
        onDrop("secret_key");
        return;
    }
    if (!validKey) {
        onDrop("not_allowed");
        return;
    }
    if (contentKey.test(key) || sensitiveSemantic.test(key)) {
        onDrop("content_key");
        return;
    }
    if (!(fleetAttributes.includes(key) ||
        semanticPrefixes.some((prefix) => key.startsWith(prefix)))) {
        onDrop("not_allowed");
        return;
    }
    if (typeof value === "string") {
        return stringValue(key, value, onDrop);
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (Array.isArray(value) && value.length <= 16) {
        return arrayValue(key, value, onDrop);
    }
    onDrop("invalid_value");
};
export const sanitizeAttributes = (attributes, onDrop) => {
    const clean = {};
    let count = 0;
    for (const [key, value] of attributes) {
        count += 1;
        if (count > 64) {
            onDrop("limit");
            break;
        }
        const result = sanitizeAttribute(key, value, onDrop);
        if (result !== undefined) {
            clean[key] = result;
        }
    }
    return clean;
};
// Names must be static instrumentation identifiers, never interpolated user input.
export const eventName = (value, onDrop) => {
    if (typeof value === "string" &&
        /^[A-Za-z][A-Za-z0-9_.:-]{0,78}$/u.test(value) &&
        !looksLikeCredential(value)) {
        return value;
    }
    onDrop("free_text");
    return "<redacted>";
};
