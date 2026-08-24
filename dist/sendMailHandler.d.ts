import type { Handler } from "aws-lambda";
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
export declare const createSendMailHandler: (config: SendMailConfig) => Handler;
export interface RecaptchaVerdict {
    ok: boolean;
    reason?: string;
    score?: number;
    action?: string;
}
//# sourceMappingURL=sendMailHandler.d.ts.map