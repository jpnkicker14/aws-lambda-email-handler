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

const BOUNDARY = "----TestBoundary1234";

/** Builds a multipart/form-data body as raw bytes so file parts carry real binary content. */
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

function buildMultipartEvent(body: Buffer, base64 = false): APIGatewayEvent {
    return {
        resource: "/",
        path: "/careers",
        httpMethod: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
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

const FIELDS = {
    name: "Jane Doe",
    email: "jane@example.com",
    subject: "Applicant for Tax Accountant",
    message: "Please consider me.",
    recaptcha: "a-token",
};

function makeHandler(overrides: Record<string, unknown> = {}) {
    return createSendMailHandler({
        senderEmail: "noreply@example.com",
        recipientEmail: "inbox@example.com",
        skipRecaptcha: true,
        ...overrides,
    } as any);
}

/** The raw RFC822 message handed to SES for the single captured send. */
function sentRaw(): string {
    const command = sendSpy.mock.calls[0]![0] as FakeSendEmailCommand;
    return Buffer.from(command.input.Content.Raw.Data).toString("utf8");
}

describe("message construction", () => {
    beforeEach(() => {
        sendSpy.mockReset();
        sendSpy.mockResolvedValue({ MessageId: "0100000000000000-abc" });
        constructedClients.length = 0;
    });

    it("sets Reply-To to the submitter so replies do not go to the sender identity", async () => {
        const response = await invokeHandler(
            makeHandler(),
            buildEvent({
                name: "Ada",
                email: "ada@example.com",
                subject: "Hello",
                message: "A message body",
                recaptcha: "token",
            })
        );

        expect(response.statusCode).toBe(200);
        expect(sentRaw()).toMatch(/^Reply-To: ada@example\.com$/m);
    });

    it("does not make SES calls when disableSend is set", async () => {
        const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

        const response = await invokeHandler(
            makeHandler({ disableSend: true }),
            buildEvent({
                name: "Ada",
                email: "ada@example.com",
                subject: "Hello",
                message: "A message body",
                recaptcha: "token",
            })
        );

        expect(response.statusCode).toBe(200);
        expect(sendSpy).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("attachments reach SES", () => {
    // Small enough that nodemailer emits the base64 payload on a single line,
    // so the assertions below need not account for 76-column wrapping.
    const resume = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0xff]);

    beforeEach(() => {
        sendSpy.mockReset();
        sendSpy.mockResolvedValue({ MessageId: "0100000000000000-abc" });
        constructedClients.length = 0;
    });

    it("forwards a multipart file attachment with its filename and bytes intact", async () => {
        const body = multipartBody(FIELDS, [
            {
                field: "resume",
                filename: "resume.pdf",
                contentType: "application/pdf",
                content: resume,
            },
        ]);

        const response = await invokeHandler(makeHandler(), buildMultipartEvent(body));

        expect(response.statusCode).toBe(200);
        expect(sendSpy).toHaveBeenCalledTimes(1);

        const raw = sentRaw();
        expect(raw).toContain("resume.pdf");
        // The attachment bytes survive busboy buffering and MIME encoding.
        expect(raw).toContain(resume.toString("base64"));
    });

    it("handles a base64-encoded body, which is how API Gateway delivers uploads", async () => {
        const body = multipartBody(FIELDS, [
            {
                field: "resume",
                filename: "resume.pdf",
                contentType: "application/pdf",
                content: resume,
            },
        ]);

        const response = await invokeHandler(
            makeHandler(),
            buildMultipartEvent(body, true)
        );

        expect(response.statusCode).toBe(200);
        const raw = sentRaw();
        expect(raw).toContain("resume.pdf");
        expect(raw).toContain(resume.toString("base64"));
    });

    it("forwards every attachment when several are uploaded", async () => {
        const second = Buffer.from("cover letter text");
        const body = multipartBody(FIELDS, [
            {
                field: "resume",
                filename: "resume.pdf",
                contentType: "application/pdf",
                content: resume,
            },
            {
                field: "cover",
                filename: "cover.txt",
                contentType: "text/plain",
                content: second,
            },
        ]);

        const response = await invokeHandler(makeHandler(), buildMultipartEvent(body));

        expect(response.statusCode).toBe(200);
        const raw = sentRaw();
        expect(raw).toContain("resume.pdf");
        expect(raw).toContain("cover.txt");
        expect(raw).toContain(resume.toString("base64"));
        expect(raw).toContain(second.toString("base64"));
    });

    it("sends no attachment part when the submission carries no files", async () => {
        const response = await invokeHandler(
            makeHandler(),
            buildMultipartEvent(multipartBody(FIELDS))
        );

        expect(response.statusCode).toBe(200);
        expect(sentRaw()).not.toContain("Content-Disposition: attachment");
    });
});
