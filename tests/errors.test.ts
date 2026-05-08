import { describe, it, expect } from "vitest";
import { CrossdeckError, crossdeckErrorFromResponse } from "../src/errors";

describe("CrossdeckError", () => {
  it("preserves all payload fields", () => {
    const err = new CrossdeckError({
      type: "authentication_error",
      code: "invalid_api_key",
      message: "Unknown publishable key.",
      requestId: "req_abc",
      status: 401,
    });
    expect(err.type).toBe("authentication_error");
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).toBe("Unknown publishable key.");
    expect(err.requestId).toBe("req_abc");
    expect(err.status).toBe(401);
    expect(err.name).toBe("CrossdeckError");
  });

  it("is a real Error subclass (instanceof works)", () => {
    const err = new CrossdeckError({
      type: "internal_error",
      code: "boom",
      message: "explosion",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CrossdeckError);
  });
});

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Headers(headers);
  return {
    status,
    statusText: status === 401 ? "Unauthorized" : "",
    ok: status >= 200 && status < 300,
    headers: h,
    json: async () => body,
    text: async () => JSON.stringify(body),
    url: "test://",
    redirected: false,
    type: "default" as const,
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    clone() {
      return this;
    },
  } as unknown as Response;
}

describe("crossdeckErrorFromResponse", () => {
  it("parses Stripe-style envelope and copies all fields", async () => {
    const res = fakeResponse(401, {
      error: {
        type: "authentication_error",
        code: "invalid_api_key",
        message: "Unknown key.",
        request_id: "req_abc",
      },
    });
    const err = await crossdeckErrorFromResponse(res);
    expect(err.type).toBe("authentication_error");
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).toBe("Unknown key.");
    expect(err.requestId).toBe("req_abc");
    expect(err.status).toBe(401);
  });

  it("falls back to header request_id when not in body", async () => {
    const res = fakeResponse(
      400,
      {
        error: {
          type: "invalid_request_error",
          code: "missing_customer",
          message: "missing",
        },
      },
      { "x-request-id": "req_header_only" },
    );
    const err = await crossdeckErrorFromResponse(res);
    expect(err.requestId).toBe("req_header_only");
  });

  it("status-mapped fallback when body isn't an error envelope", async () => {
    const res = fakeResponse(429, { unrelated: "body" });
    const err = await crossdeckErrorFromResponse(res);
    expect(err.type).toBe("rate_limit_error");
    expect(err.status).toBe(429);
  });

  it.each([
    [401, "authentication_error"],
    [403, "permission_error"],
    [429, "rate_limit_error"],
    [400, "invalid_request_error"],
    [404, "invalid_request_error"],
    [500, "internal_error"],
    [502, "internal_error"],
    [503, "internal_error"],
  ] as const)("status %i → %s (fallback type mapping)", async (status, expected) => {
    const res = fakeResponse(status, null);
    const err = await crossdeckErrorFromResponse(res);
    expect(err.type).toBe(expected);
  });

  it("handles non-JSON bodies gracefully", async () => {
    const broken = {
      status: 500,
      statusText: "",
      ok: false,
      headers: new Headers(),
      json: async () => {
        throw new Error("Invalid JSON");
      },
    } as unknown as Response;
    const err = await crossdeckErrorFromResponse(broken);
    expect(err.type).toBe("internal_error");
    expect(err.code).toBe("http_500");
  });
});
