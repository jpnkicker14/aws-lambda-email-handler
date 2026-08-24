import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import ajvKeywords from "ajv-keywords";
import nodemailer, {} from "nodemailer";
import busboy from "busboy";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import https from "https";
import querystring from "querystring";
const ajv = new Ajv();
addFormats(ajv);
ajvKeywords(ajv);
export const createSendMailHandler = (config) => {
    const sesClient = new SESClient({ region: config.region || "us-west-2" });
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
    return async (event, _context, cb) => {
        try {
            const contentType = event.headers["content-type"] || event.headers["Content-Type"];
            const isMultipart = Boolean(contentType && contentType.includes("multipart/form-data"));
            let body;
            if (isMultipart) {
                body = (await extractMultipart(event));
            }
            else {
                try {
                    body = JSON.parse(event.body ?? "");
                }
                catch {
                    // Node embeds a slice of the input in JSON.parse messages, so
                    // neither the message nor the body is logged or echoed back.
                    console.warn("Request body is not valid JSON; rejecting.");
                    return cb(null, buildErrorResponse(new Error("Invalid input"), "Invalid input", 400));
                }
            }
            const valid = validate(body);
            if (!valid) {
                const msg = validate.errors?.[0]?.message || "Invalid input";
                return cb(null, buildErrorResponse(new Error(msg), msg, 400));
            }
            if (!config.skipRecaptcha) {
                const expectedAction = isMultipart
                    ? (config.recaptchaMultipartAction ?? config.recaptchaExpectedAction)
                    : config.recaptchaExpectedAction;
                const verdict = await verifyRecaptchaToken(body.recaptcha, config, expectedAction);
                if (!verdict.ok) {
                    // Reason, score and action only — never the token or the secret.
                    console.warn(`reCAPTCHA rejected: ${verdict.reason}`);
                    return cb(null, buildErrorResponse(new Error("Invalid reCAPTCHA"), "reCAPTCHA failed", 400));
                }
            }
            const mailOptions = {
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
            }
            else {
                const transporter = createSesTransport(sesClient);
                await transporter.sendMail(mailOptions);
            }
            return cb(null, buildSuccessResponse("Mail sent successfully"));
        }
        catch (err) {
            // Log the type, not the error text: messages derived from the request
            // body can carry submitter data.
            console.error(`Unhandled error in sendMail handler: ${err?.name ?? "Error"}`);
            return cb(null, buildErrorResponse(new Error("Internal error"), "Internal error, please try again later", 500));
        }
    };
};
function buildSuccessResponse(message, statusCode = 200) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message }),
    };
}
function buildErrorResponse(err, message, statusCode = 500) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ message, error: err.message }),
    };
}
function extractMultipart(event) {
    return new Promise((resolve, reject) => {
        const bb = busboy({
            headers: {
                "content-type": event.headers["content-type"] || event.headers["Content-Type"],
            },
        });
        const result = { files: [] };
        bb.on("file", (_field, fileStream, info) => {
            const chunks = [];
            fileStream.on("data", (data) => chunks.push(data));
            fileStream.on("end", () => {
                result.files.push({
                    filename: info.filename,
                    contentType: info.mimeType,
                    content: Buffer.concat(chunks),
                });
            });
        });
        bb.on("field", (fieldname, value) => {
            result[fieldname] = value;
        });
        bb.on("error", reject);
        bb.on("close", () => {
            resolve({
                ...result,
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
function createSesTransport(sesClient) {
    const options = {
        SES: {
            ses: sesClient,
            aws: {
                SendRawEmailCommand,
            },
        },
    };
    return nodemailer.createTransport(options);
}
const DEFAULT_MIN_SCORE = 0.5;
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
async function verifyRecaptchaToken(token, config, expectedAction) {
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
    let payload;
    try {
        payload = await postSiteVerify(postData);
    }
    catch (err) {
        console.error(`reCAPTCHA siteverify request failed: ${err?.message ?? err}`);
        return { ok: false, reason: "request-failed" };
    }
    const score = payload.score;
    const action = payload.action;
    const withDetails = (verdict) => ({
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
function postSiteVerify(postData) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "www.google.com",
            path: "/recaptcha/api/siteverify",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData),
            },
            timeout: 5000,
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
        req.on("timeout", () => req.destroy(new Error("siteverify timed out")));
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}
//# sourceMappingURL=sendMailHandler.js.map