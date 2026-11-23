# aws-lambda-ses-mailer

Reusable AWS Lambda handler that validates incoming contact-form requests, verifies Google reCAPTCHA tokens, and forwards the message via Amazon SES v2.

## Installation

```bash
npm install aws-lambda-ses-mailer
# or
yarn add aws-lambda-ses-mailer
```

The package ships ESM output and targets Node.js 18+, matching current Lambda runtimes.

## Quick Start

```ts
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createSendMailHandler } from "aws-lambda-ses-mailer";

const sendMail = createSendMailHandler({
  region: "us-west-2",
  senderEmail: "no-reply@example.com",
  recipientEmail: "hello@example.com",
  recaptchaSecret: process.env.RECAPTCHA_SECRET,
});

export const handler: APIGatewayProxyHandlerV2 = async (event, context, callback) => {
  return sendMail(event, context, callback);
};
```

Deploy the exported `handler` in your AWS Lambda function behind an API Gateway endpoint that accepts JSON or `multipart/form-data` POST bodies.

## Handler Configuration

| Option            | Required | Description                                                                                  |
| ----------------- | -------- | -------------------------------------------------------------------------------------------- |
| `senderEmail`     | ✅       | Email address shown as the sender when SES sends the message.                                |
| `recipientEmail`  | ✅       | Destination address that receives the forwarded message.                                     |
| `region`          | ➖       | AWS region for the SES client (defaults to `us-west-2`).                                      |
| `recaptchaSecret` | ➖       | Secret key for Google reCAPTCHA v2/v3 verification. Set to `undefined` to disable checks.    |
| `skipRecaptcha`   | ➖       | Set to `true` to bypass reCAPTCHA verification without supplying a secret (useful in tests). |
| `disableSend`     | ➖       | When `true`, skips the SES send call but still returns success (useful in CI/test).          |

## IAM Permissions

Mail is sent with the SES **v2** `SendEmail` API (`@aws-sdk/client-sesv2`), so the
Lambda execution role must allow `ses:SendEmail`:

```yaml
Policies:
  - Statement:
      - Effect: Allow
        Action:
          - ses:SendEmail
        Resource: "*"
```

The v1 action `ses:SendRawEmail` does **not** authorise this call. A role that
only grants `ses:SendRawEmail` will build and test clean but fail at runtime with
an `AccessDenied` error, so roles carried over from v2.x of this package need
updating.

The handler validates incoming payloads with AJV. A valid request must include:

```json
{
  "name": "Sender Name",
  "email": "sender@example.com",
  "subject": "Hello",
  "message": "Body text",
  "recaptcha": "token-from-client"
}
```

Requests sent with `multipart/form-data` can also include file attachments. Each file is streamed into memory as a `Buffer` and forwarded to SES as an attachment.

## Local Development

Clone the repository and install dependencies:

```bash
npm install
```

Available scripts:

- `npm run build` – Compile TypeScript sources into `dist/`.
- `npm test` – Run the Jest test suite (uses `node --experimental-vm-modules` to execute ESM tests).

Before publishing, ensure `npm run build` completes without errors and that the generated `dist/` artifacts look as expected.

## Testing Notes

The suite covers payload validation, reCAPTCHA verification, multipart parsing
with file attachments, and the SES send path, and runs on Node 20 and 22 in CI.

Two approaches are used, and either works for your own tests:

- **`disableSend: true`** skips the SES call entirely and still returns success.
  Simplest when the SES call is not what you are testing.
- **Stubbing `@aws-sdk/client-sesv2`** with `jest.unstable_mockModule`, as
  `src/sesTransport.spec.ts` does, when you need to assert on what was actually
  sent. The stub replaces `SESv2Client` and `SendEmailCommand`, so the real
  nodemailer transport still runs and builds the raw message — no network calls.

To generate a realistic event payload for manual testing, use the [API Gateway Lambda proxy](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html) structure and provide either a JSON body or a base64-encoded multipart payload.

## License

MIT © Kenton Chun
