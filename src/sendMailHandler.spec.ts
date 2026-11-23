import type { APIGatewayEvent } from "aws-lambda";
import { jest } from "@jest/globals";
import { createSendMailHandler } from "./sendMailHandler";

const originalEnv = { ...process.env };

// Helper: builds a fake API Gateway event
function buildEvent(body: Record<string, unknown>): APIGatewayEvent {
    return {
        resource: "/",
        path: "/contact",
        httpMethod: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        multiValueHeaders: {},
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        body: JSON.stringify(body),
        isBase64Encoded: false,
    };
}

// Helper: invokes the handler with a test event
async function invokeHandler(handler, event: APIGatewayEvent) {
    return new Promise<any>((resolve, reject) => {
        handler(event, {} as any, (err, response) => {
            if (err) reject(err);
            else resolve(response);
        });
    });
}

describe("createSendMailHandler", () => {
    let sendMailHandler;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            SENDER_EMAIL: "sender@example.com",
        };

        sendMailHandler = createSendMailHandler({
            senderEmail: process.env.SENDER_EMAIL!,
            recipientEmail: "recipient@example.com",
            skipRecaptcha: true, // disables reCAPTCHA for tests
            disableSend: true, // prevents SES calls
        });
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it("responds with success when the payload is valid", async () => {
        const event = buildEvent({
            name: "Jane Doe",
            email: "jane@example.com",
            subject: "Hello there",
            message: "Just saying hi!",
            recaptcha: "token",
        });

        const response = await invokeHandler(sendMailHandler, event);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.message).toBe("Mail sent successfully");
    });

    it("returns a validation error when required fields are missing", async () => {
        const event = buildEvent({
            email: "jane@example.com",
            subject: "Hello there",
            message: "Just saying hi!",
            recaptcha: "token",
        });

        const response = await invokeHandler(sendMailHandler, event);

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.message).toMatch(/required property/i);
    });
});

const BOUNDARY = "----TestBoundary1234";

/**
 * Builds a multipart/form-data body as raw bytes, so that file parts can carry
 * genuine binary content rather than only text.
 */
function multipartBody(
    fields: Record<string, string>,
    files: Array<{ field: string; filename: string; contentType: string; content: Buffer }> = []
): Buffer {
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(
            Buffer.from(
                `--${BOUNDARY}\r\n` +
                    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
                    `${value}\r\n`
            )
        );
    }
    for (const file of files) {
        parts.push(
            Buffer.from(
                `--${BOUNDARY}\r\n` +
                    `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
                    `Content-Type: ${file.contentType}\r\n\r\n`
            ),
            file.content,
            Buffer.from("\r\n")
        );
    }
    parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(parts);
}

function buildMultipartEvent(
    body: Buffer,
    opts: { base64?: boolean; headerName?: "Content-Type" | "content-type" } = {}
): APIGatewayEvent {
    const base64 = opts.base64 ?? false;
    const headerName = opts.headerName ?? "Content-Type";
    return {
        resource: "/",
        path: "/careers",
        httpMethod: "POST",
        headers: {
            [headerName]: `multipart/form-data; boundary=${BOUNDARY}`,
        },
        multiValueHeaders: {},
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        body: base64 ? body.toString("base64") : body.toString("binary"),
        isBase64Encoded: base64,
    } as APIGatewayEvent;
}

const VALID_FIELDS = {
    name: "Jane Doe",
    email: "jane@example.com",
    subject: "Hello there",
    message: "Just saying hi!",
    recaptcha: "token",
};

describe("payload validation", () => {
    const handler = createSendMailHandler({
        senderEmail: "sender@example.com",
        recipientEmail: "recipient@example.com",
        skipRecaptcha: true,
        disableSend: true,
    });

    beforeEach(() => {
        jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("rejects a malformed email address", async () => {
        // ajv-formats is a dependency purely for this `format: "email"` check.
        const response = await invokeHandler(
            handler,
            buildEvent({ ...VALID_FIELDS, email: "not-an-email" })
        );

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).message).toMatch(/email/i);
    });

    it.each([
        ["name", { ...VALID_FIELDS, name: undefined }],
        ["subject", { ...VALID_FIELDS, subject: undefined }],
        ["message", { ...VALID_FIELDS, message: undefined }],
        ["recaptcha", { ...VALID_FIELDS, recaptcha: undefined }],
    ])("rejects a payload missing %s", async (_field, body) => {
        const response = await invokeHandler(handler, buildEvent(body as any));
        expect(response.statusCode).toBe(400);
    });

    it("rejects a body that is not valid JSON", async () => {
        const event = buildEvent(VALID_FIELDS);
        event.body = "{not json";

        const response = await invokeHandler(handler, event);

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body).message).toBe("Invalid input");
    });

    it("rejects a non-string field of the right name", async () => {
        const response = await invokeHandler(
            handler,
            buildEvent({ ...VALID_FIELDS, subject: 42 })
        );

        expect(response.statusCode).toBe(400);
    });
});

describe("response envelope", () => {
    const handler = createSendMailHandler({
        senderEmail: "sender@example.com",
        recipientEmail: "recipient@example.com",
        skipRecaptcha: true,
        disableSend: true,
    });

    beforeEach(() => {
        jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("sets permissive CORS headers on success", async () => {
        const response = await invokeHandler(handler, buildEvent(VALID_FIELDS));

        expect(response.statusCode).toBe(200);
        expect(response.headers).toEqual({
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
    });

    it("sets the same CORS headers on a validation failure", async () => {
        const response = await invokeHandler(
            handler,
            buildEvent({ ...VALID_FIELDS, email: "nope" })
        );

        expect(response.statusCode).toBe(400);
        expect(response.headers).toEqual({
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
    });
});

describe("multipart parsing", () => {
    const handler = createSendMailHandler({
        senderEmail: "sender@example.com",
        recipientEmail: "recipient@example.com",
        skipRecaptcha: true,
        disableSend: true,
    });

    beforeEach(() => {
        jest.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("accepts a multipart submission with no files", async () => {
        const response = await invokeHandler(
            handler,
            buildMultipartEvent(multipartBody(VALID_FIELDS))
        );

        expect(response.statusCode).toBe(200);
    });

    it("reads the boundary from a lowercase content-type header", async () => {
        // API Gateway's HTTP APIs lowercase request headers, so this is a real
        // production path, not a curiosity.
        const response = await invokeHandler(
            handler,
            buildMultipartEvent(multipartBody(VALID_FIELDS), {
                headerName: "content-type",
            })
        );

        expect(response.statusCode).toBe(200);
    });

    it("validates multipart fields the same way as JSON", async () => {
        const response = await invokeHandler(
            handler,
            buildMultipartEvent(
                multipartBody({ ...VALID_FIELDS, email: "not-an-email" })
            )
        );

        expect(response.statusCode).toBe(400);
    });
});
