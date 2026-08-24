import { EventEmitter } from "events";
import type { APIGatewayEvent } from "aws-lambda";

import { jest } from "@jest/globals";

const httpsRequest = jest.fn();

jest.unstable_mockModule("https", () => ({
    default: { request: httpsRequest },
    request: httpsRequest,
}));

const { createSendMailHandler } = await import("./sendMailHandler");

/**
 * Stubs https.request so siteverify answers with the given JSON payload,
 * mimicking the callback/stream shape the real module uses.
 */
const stubSiteVerify = (payload: unknown) => {
    httpsRequest.mockImplementation(((_options: unknown, cb: any) => {
        const res = new EventEmitter();
        const req = Object.assign(new EventEmitter(), {
            write: () => true,
            end: () => {
                setImmediate(() => {
                    cb(res);
                    res.emit("data", JSON.stringify(payload));
                    res.emit("end");
                });
            },
            destroy: () => undefined,
        });
        return req;
    }) as never);
};

const stubSiteVerifyFailure = () => {
    httpsRequest.mockImplementation(((_options: unknown, _cb: any) => {
        const req = Object.assign(new EventEmitter(), {
            write: () => true,
            end: () => {
                setImmediate(() => req.emit("error", new Error("network down")));
            },
            destroy: () => undefined,
        });
        return req;
    }) as never);
};

const buildEvent = (body: Record<string, unknown>): APIGatewayEvent =>
    ({
        resource: "/",
        path: "/contact",
        httpMethod: "POST",
        headers: { "Content-Type": "application/json" },
        multiValueHeaders: {},
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as never,
        body: JSON.stringify(body),
        isBase64Encoded: false,
    }) as APIGatewayEvent;

const VALID_BODY = {
    name: "Jane Doe",
    email: "jane@example.com",
    subject: "Hello",
    message: "Just saying hi",
    recaptcha: "a-token",
};

const invoke = (handler: any, event: APIGatewayEvent) =>
    new Promise<any>((resolve, reject) => {
        handler(event, {} as never, (err: unknown, response: unknown) => {
            if (err) reject(err);
            else resolve(response);
        });
    });

const makeHandler = (overrides: Record<string, unknown> = {}) =>
    createSendMailHandler({
        senderEmail: "sender@example.com",
        recipientEmail: "recipient@example.com",
        recaptchaSecret: "a-secret",
        disableSend: true,
        ...overrides,
    });

const run = async (overrides: Record<string, unknown> = {}) =>
    invoke(makeHandler(overrides), buildEvent(VALID_BODY));

describe("reCAPTCHA v3 verification", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("accepts a token with a good score and matching action", async () => {
        stubSiteVerify({ success: true, score: 0.9, action: "contact_form" });

        const response = await run({ recaptchaExpectedAction: "contact_form" });

        expect(response.statusCode).toBe(200);
    });

    it("rejects a low-scoring token even though success is true", async () => {
        stubSiteVerify({ success: true, score: 0.1, action: "contact_form" });

        const response = await run();

        expect(response.statusCode).toBe(400);
    });

    it("accepts a low score when the threshold is lowered", async () => {
        stubSiteVerify({ success: true, score: 0.3, action: "contact_form" });

        const response = await run({ recaptchaMinScore: 0.2 });

        expect(response.statusCode).toBe(200);
    });

    it("rejects a token issued for a different action", async () => {
        stubSiteVerify({ success: true, score: 0.9, action: "career_form" });

        const response = await run({ recaptchaExpectedAction: "contact_form" });

        expect(response.statusCode).toBe(400);
    });

    it("rejects when Google reports success: false", async () => {
        stubSiteVerify({ success: false, "error-codes": ["invalid-input-secret"] });

        const response = await run();

        expect(response.statusCode).toBe(400);
    });

    it("rejects a response with no score, as a v2 secret returns", async () => {
        stubSiteVerify({ success: true });

        const response = await run();

        expect(response.statusCode).toBe(400);
    });

    it("fails closed when no secret is configured", async () => {
        stubSiteVerify({ success: true, score: 0.9, action: "contact_form" });

        const response = await run({ recaptchaSecret: undefined });

        expect(response.statusCode).toBe(400);
        // Never reaches out to Google without a secret.
        expect(httpsRequest).not.toHaveBeenCalled();
    });

    it("fails closed when siteverify is unreachable", async () => {
        stubSiteVerifyFailure();

        const response = await run();

        expect(response.statusCode).toBe(400);
    });

    it("still honours skipRecaptcha for local runs", async () => {
        stubSiteVerify({ success: false });

        const response = await run({ skipRecaptcha: true });

        expect(response.statusCode).toBe(200);
        expect(httpsRequest).not.toHaveBeenCalled();
    });

    it("logs neither the token nor the secret when rejecting", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
        stubSiteVerify({ success: true, score: 0.1, action: "contact_form" });

        await run();

        const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("low-score");
        expect(logged).not.toContain("a-token");
        expect(logged).not.toContain("a-secret");
    });
});
