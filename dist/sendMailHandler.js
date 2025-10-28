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
            let body;
            if (contentType && contentType.includes("multipart/form-data")) {
                body = (await extractMultipart(event));
            }
            else {
                body = JSON.parse(event.body ?? "");
            }
            const valid = validate(body);
            if (!valid) {
                const msg = validate.errors?.[0]?.message || "Invalid input";
                return cb(null, buildErrorResponse(new Error(msg), msg, 400));
            }
            if (!config.skipRecaptcha) {
                const verified = await verifyRecaptchaToken(body.recaptcha, config.recaptchaSecret);
                if (!verified)
                    return cb(null, buildErrorResponse(new Error("Invalid reCAPTCHA"), "reCAPTCHA failed", 400));
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
            console.error(err);
            return cb(null, buildErrorResponse(err, "Internal error, please try again later", 500));
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
async function verifyRecaptchaToken(token, secret) {
    if (!secret) {
        console.warn("No reCAPTCHA secret configured — skipping verification.");
        return true;
    }
    const postData = querystring.stringify({ secret, response: token });
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "www.google.com",
            path: "/recaptcha/api/siteverify",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData),
            },
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.success);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}
//# sourceMappingURL=sendMailHandler.js.map