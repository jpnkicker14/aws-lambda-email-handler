import type { APIGatewayEvent } from "aws-lambda";
import { jest } from "@jest/globals";

/**
 * The send path was previously uncovered: every other spec runs with
 * `disableSend`, so nothing exercised the nodemailer SES transport wiring.
 *
 * nodemailer 10 reads `options.SES.sesClient` and `options.SES.SendEmailCommand`
 * at runtime, so a wrong key would type-check against nothing and only fail in
 * production. These tests stub @aws-sdk/client-sesv2 and assert that nodemailer
 * really does construct SendEmailCommand and dispatch it through the client.
 */

const sendSpy = jest.fn<(command: unknown) => Promise<{ MessageId: string }>>();

class FakeSendEmailCommand {
    constructor(public readonly input: Record<string, any>) {}
}

const constructedClients: Array<{ region?: string }> = [];

class FakeSESv2Client {
    public readonly config: { region: () => Promise<string> };
    constructor(public readonly clientConfig: { region?: string }) {
        constructedClients.push(clientConfig);
        this.config = { region: async () => clientConfig.region ?? "unset" };
    }
    send(command: unknown) {
        return sendSpy(command);
    }
}

jest.unstable_mockModule("@aws-sdk/client-sesv2", () => ({
    SESv2Client: FakeSESv2Client,
    SendEmailCommand: FakeSendEmailCommand,
}));

const { createSendMailHandler } = await import("./sendMailHandler");

function buildEvent(body: Record<string, unknown>): APIGatewayEvent {
    return {
        resource: "/",
        path: "/contact",
        httpMethod: "POST",
        headers: { "Content-Type": "application/json" },
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

function invokeHandler(handler: any, event: APIGatewayEvent) {
    return new Promise<any>((resolve, reject) => {
        handler(event, {} as any, (err: unknown, response: unknown) =>
            err ? reject(err) : resolve(response)
        );
    });
}

const validBody = {
    name: "Ada",
    email: "ada@example.com",
    subject: "Hello",
    message: "A message body",
    recaptcha: "token",
};

describe("SESv2 transport wiring", () => {
    beforeEach(() => {
        sendSpy.mockReset();
        sendSpy.mockResolvedValue({ MessageId: "0100000000000000-abc" });
        constructedClients.length = 0;
    });

    it("sends through SendEmailCommand on the SESv2 client", async () => {
        const handler = createSendMailHandler({
            senderEmail: "noreply@example.com",
            recipientEmail: "inbox@example.com",
            skipRecaptcha: true,
        });

        const response = await invokeHandler(handler, buildEvent(validBody));

        expect(response.statusCode).toBe(200);
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const command = sendSpy.mock.calls[0]![0] as FakeSendEmailCommand;
        expect(command).toBeInstanceOf(FakeSendEmailCommand);
        expect(command.input.FromEmailAddress).toBe("noreply@example.com");
        expect(command.input.Destination.ToAddresses).toEqual(["inbox@example.com"]);

        const raw = Buffer.from(command.input.Content.Raw.Data).toString("utf8");
        expect(raw).toContain("Subject: Hello");
        expect(raw).toContain("ada@example.com");
        expect(raw).toContain("A message body");
    });

    it("honours the configured region and defaults to us-west-2", async () => {
        createSendMailHandler({
            senderEmail: "noreply@example.com",
            recipientEmail: "inbox@example.com",
            skipRecaptcha: true,
            region: "eu-west-1",
        });
        createSendMailHandler({
            senderEmail: "noreply@example.com",
            recipientEmail: "inbox@example.com",
            skipRecaptcha: true,
        });

        expect(constructedClients).toEqual([
            { region: "eu-west-1" },
            { region: "us-west-2" },
        ]);
    });

    it("returns a 500 and does not leak the SES error when sending fails", async () => {
        sendSpy.mockRejectedValue(
            Object.assign(new Error("ses rejected ada@example.com"), {
                name: "MessageRejected",
            })
        );
        const error = jest.spyOn(console, "error").mockImplementation(() => {});

        const handler = createSendMailHandler({
            senderEmail: "noreply@example.com",
            recipientEmail: "inbox@example.com",
            skipRecaptcha: true,
        });

        const response = await invokeHandler(handler, buildEvent(validBody));

        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain("ada@example.com");
        const logged = error.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).not.toContain("ada@example.com");
        error.mockRestore();
    });
});
