import type { APIGatewayEvent } from "aws-lambda";
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
