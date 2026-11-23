import { Ajv, type ErrorObject, type Plugin } from "ajv";
import addFormats from "ajv-formats";
import ajvKeywords from "ajv-keywords";
import type { APIGatewayEvent, Callback, Context, Handler } from "aws-lambda";
import nodemailer, {
    type SendMailOptions,
    type SESSentMessageInfo,
    type SESTransportOptions,
    type Transporter,
} from "nodemailer";
import busboy from "busboy";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import https from "https";
import querystring from "querystring";

const ajv = new Ajv();
(addFormats as unknown as Plugin<unknown>)(ajv);
(ajvKeywords as unknown as Plugin<unknown>)(ajv);

export interface SendMailConfig {
    region?: string;
    skipRecaptcha?: boolean;
    disableSend?: boolean;
    senderEmail: string;
    recipientEmail: string;
    recaptchaSecret?: string;
    /**
     * Minimum reCAPTCHA v3 score (0.0-1.0) required to accept a submission.
     * Defaults to 0.5. A v2 secret returns no score and is always rejected.
     */
    recaptchaMinScore?: number;
    /**
     * Expected reCAPTCHA v3 action for this endpoint (e.g. "contact_form").
     * When set, a token issued for any other action is rejected.
     */
    recaptchaExpectedAction?: string;
    /**
     * Expected reCAPTCHA v3 action for multipart/form-data submissions
     * (e.g. "career_form"), which typically come from a different form than
     * JSON submissions. Falls back to `recaptchaExpectedAction` when unset.
     */
    recaptchaMultipartAction?: string;
}

export interface PostBody {
    name: string;
    email: string;
    subject: string;
    message: string;
    recaptcha: string;
    files?: Array<{
        filename: string;
        contentType: string;
        content: Buffer;
    }>;
}

export const createSendMailHandler = (config: SendMailConfig): Handler => {
    const sesClient = new SESv2Client({ region: config.region || "us-west-2" });

    const schema = {
        type: "object",
        properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            subject: { type: "string" },
            message: { type: "string" },
            recaptcha: { type: "string" },
        },
        required: ["name", "email", "subject", "message", "recaptcha"],
    };

    const validate = ajv.compile(schema);

    return async (event: APIGatewayEvent, _context: Context, cb: Callback) => {
        try {
            const contentType =
                event.headers["content-type"] || event.headers["Content-Type"];
            const isMultipart = Boolean(
                contentType && contentType.includes("multipart/form-data")
            );
            let body: PostBody;

            if (isMultipart) {
                body = (await extractMultipart(event)) as any;
            } else {
                try {
                    body = JSON.parse(event.body ?? "");
                } catch {
                    // Node embeds a slice of the input in JSON.parse messages, so
                    // neither the message nor the body is logged or echoed back.
                    console.warn("Request body is not valid JSON; rejecting.");
                    return cb(
                        null,
                        buildErrorResponse(new Error("Invalid input"), "Invalid input", 400)
                    );
                }
            }

            const valid = validate(body);
            if (!valid) {
                const msg = (validate.errors?.[0] as ErrorObject)?.message || "Invalid input";
                return cb(null, buildErrorResponse(new Error(msg), msg, 400));
            }

            if (!config.skipRecaptcha) {
                const expectedAction = isMultipart
                    ? (config.recaptchaMultipartAction ?? config.recaptchaExpectedAction)
                    : config.recaptchaExpectedAction;
                const verdict = await verifyRecaptchaToken(
                    body.recaptcha,
                    config,
                    expectedAction
                );
                if (!verdict.ok) {
                    // Reason, score and action only — never the token or the secret.
                    console.warn(`reCAPTCHA rejected: ${verdict.reason}`);
                    return cb(
                        null,
                        buildErrorResponse(new Error("Invalid reCAPTCHA"), "reCAPTCHA failed", 400)
                    );
                }
            }

            const mailOptions: SendMailOptions = {
                from: config.senderEmail,
                to: config.recipientEmail,
                subject: body.subject,
                text: body.message,
                replyTo: body.email,
            };

            if (body.files) {
                mailOptions.attachments = body.files.map((file) => ({
                    filename: file.filename,
                    content: file.content,
                }));
            }

            if (config.disableSend) {
                console.warn("Email sending disabled. Returning success for testing.");
            } else {
                const transporter = createSesTransport(sesClient);
                await transporter.sendMail(mailOptions);
            }

            return cb(null, buildSuccessResponse("Mail sent successfully"));
        } catch (err: any) {
            // Log the type, not the error text: messages derived from the request
            // body can carry submitter data.
            console.error(`Unhandled error in sendMail handler: ${err?.name ?? "Error"}`);
            return cb(
                null,
                buildErrorResponse(
                    new Error("Internal error"),
                    "Internal error, please try again later",
                    500
                )
            );
        }
    };
};

function buildSuccessResponse(message: string, statusCode = 200) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message }),
    };
}

function buildErrorResponse(err: Error, message: string, statusCode = 500) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message, error: err.message }),
    };
}

function extractMultipart(event: APIGatewayEvent): Promise<PostBody> {
    return new Promise((resolve, reject) => {
        const bb = busboy({
            headers: {
                "content-type":
                    event.headers["content-type"] || event.headers["Content-Type"],
            },
        });
        const result: Partial<PostBody> & {
            files: NonNullable<PostBody["files"]>;
        } = { files: [] };

        bb.on("file", (_field, fileStream, info) => {
            const chunks: Buffer[] = [];
            fileStream.on("data", (data: Buffer) => chunks.push(data));
            fileStream.on("end", () => {
                result.files.push({
                    filename: info.filename,
                    contentType: info.mimeType,
                    content: Buffer.concat(chunks),
                });
            });
        });

        bb.on("field", (fieldname, value) => {
            (result as Record<string, unknown>)[fieldname] = value;
        });
        bb.on("error", reject);
        bb.on("close", () => {
            resolve({
                ...(result as Omit<PostBody, "files">),
                files: result.files,
            });
        });

        const encoding = event.isBase64Encoded ? "base64" : "binary";
        if (event.body) {
            bb.write(event.body, encoding);
        }
        bb.end();
    });
}

function createSesTransport(
    sesClient: SESv2Client
): Transporter<SESSentMessageInfo, SESTransportOptions> {
    // nodemailer 10's SES transport speaks SESv2: it takes the client as
    // `sesClient` and the `SendEmailCommand` constructor alongside it.
    return nodemailer.createTransport({
        SES: {
            sesClient,
            SendEmailCommand,
        },
    });
}

const DEFAULT_MIN_SCORE = 0.5;

interface SiteVerifyResponse {
    success?: boolean;
    score?: number;
    action?: string;
    "error-codes"?: string[];
}

export interface RecaptchaVerdict {
    ok: boolean;
    reason?: string;
    score?: number;
    action?: string;
}

/**
 * Verifies a reCAPTCHA token against Google's siteverify endpoint.
 *
 * reCAPTCHA v3 never challenges the user and returns `success: true` for
 * virtually any well-formed token, so `success` alone is not a meaningful
 * check — the score and the action are. Every failure path rejects: a missing
 * secret, a transport error, a malformed response, or a response carrying no
 * score (which is what a v2 secret returns for a v3 token).
 *
 * Neither the token nor the secret is ever logged.
 */
async function verifyRecaptchaToken(
    token: string,
    config: SendMailConfig,
    expectedAction?: string
): Promise<RecaptchaVerdict> {
    const secret = config.recaptchaSecret;
    if (!secret) {
        // Fail closed. A missing secret is a deployment fault, not a bypass.
        console.error("No reCAPTCHA secret configured; rejecting submission.");
        return { ok: false, reason: "missing-secret" };
    }
    if (!token) {
        return { ok: false, reason: "missing-token" };
    }

    const minScore = config.recaptchaMinScore ?? DEFAULT_MIN_SCORE;
    const postData = querystring.stringify({ secret, response: token });

    let payload: SiteVerifyResponse;
    try {
        payload = await postSiteVerify(postData);
    } catch (err: any) {
        console.error(`reCAPTCHA siteverify request failed: ${err?.message ?? err}`);
        return { ok: false, reason: "request-failed" };
    }

    const score = payload.score;
    const action = payload.action;
    const withDetails = (verdict: RecaptchaVerdict): RecaptchaVerdict => ({
        ...verdict,
        ...(score === undefined ? {} : { score }),
        ...(action === undefined ? {} : { action }),
    });

    if (payload.success !== true) {
        // `invalid-input-secret` means the secret does not pair with the site key.
        const codes = payload["error-codes"]?.join(",") || "none";
        return withDetails({ ok: false, reason: `rejected-by-google (${codes})` });
    }
    if (typeof score !== "number") {
        return withDetails({ ok: false, reason: "missing-score" });
    }
    if (score < minScore) {
        return withDetails({ ok: false, reason: `low-score (${score} < ${minScore})` });
    }
    if (expectedAction !== undefined && action !== expectedAction) {
        return withDetails({
            ok: false,
            reason: `action-mismatch (got ${action ?? "none"}, expected ${expectedAction})`,
        });
    }

    return withDetails({ ok: true });
}

function postSiteVerify(postData: string): Promise<SiteVerifyResponse> {
    return new Promise<SiteVerifyResponse>((resolve, reject) => {
        const req = https.request(
            {
                hostname: "www.google.com",
                path: "/recaptcha/api/siteverify",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Length": Buffer.byteLength(postData),
                },
                timeout: 5000,
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(data) as SiteVerifyResponse);
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error("siteverify timed out")));
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}
