import type { Handler } from "aws-lambda";
export interface SendMailConfig {
    region?: string;
    skipRecaptcha?: boolean;
    disableSend?: boolean;
    senderEmail: string;
    recipientEmail: string;
    recaptchaSecret?: string;
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
//# sourceMappingURL=sendMailHandler.d.ts.map