import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateUrl, isValidIpv6, isValidSsn } from "../technical-rules.js";
import { patternFindings } from "../detection-rules.js";

const found = (text) => patternFindings(text).map(({ type, value }) => [type, value]);
const types = (text) => found(text).map(([type]) => type);

test("technical text without private identifiers produces no findings", () => {
  for (const text of [
    "Use arn:aws:iam::aws:policy/AdministratorAccess for the demo role.",
    "Allow arn:aws:s3:::* in the policy.",
    "Open https://github.com/anthropics/anthropic-sdk-python and https://docs.aws.amazon.com/iam/",
    "Call ec2.us-east-1.amazonaws.com or sts.amazonaws.com for the API.",
    "Set max_tokens: 4096 and token_count = len(tokens).",
    "password: string and secret_name = my-db-secret",
    "export DB_PASSWORD=$DB_PASSWORD and api_key = os.environ['KEY']",
    "token: ${{ secrets.GITHUB_TOKEN }}",
    "Load .env.local and config.local before starting.",
    "std::string and a::b are C++ names; the time is 10:30:45.",
    "See /api/Users/123 and https://example.org/home/dashboard for routes.",
    "GET /home/:id and /Users/{id}",
    "The account number is required and the account was created in 2024.",
    "Basic understanding of Bearer tokens helps.",
    "Commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 fixed it.",
    "Invalid SSNs such as 000-12-3456, 666-12-3456 and 123-00-6789 fail the checksum rules.",
    "A passport photo is needed. Passport size: 35mm",
    "Connect with postgres://localhost:5432/app or redis://localhost",
    "mongodb://user:password@host:27017/db",
  ]) {
    assert.deepEqual(found(text), [], text);
  }
});

test("AWS account IDs are detected from labels, JSON output and ARNs", () => {
  assert.deepEqual(found("my AWS account ID is 123456789012"), [["CLOUD_ACCOUNT_ID", "123456789012"]]);
  assert.deepEqual(found("aws_account_id = 123456789012"), [["CLOUD_ACCOUNT_ID", "123456789012"]]);
  assert.deepEqual(found("Account number: 1234-5678-9012"), [["CLOUD_ACCOUNT_ID", "1234-5678-9012"]]);
  assert.deepEqual(found(`{ "UserId": "x", "Account": "123456789012" }`), [["CLOUD_ACCOUNT_ID", "123456789012"]]);
  const arn = "arn:aws:iam::123456789012:role/payroll-admin";
  assert.deepEqual(found(`assume ${arn}.`), [["CLOUD_RESOURCE", arn]]);
  assert.deepEqual(found("arn:aws:s3:::unicef-hr-exports/2024/"), [["CLOUD_RESOURCE", "arn:aws:s3:::unicef-hr-exports/2024/"]]);
});

test("bank account numbers need an account-number label", () => {
  assert.deepEqual(found("account number: 00123456789"), [["ACCOUNT_NUMBER", "00123456789"]]);
  assert.deepEqual(found("Account No. 1234567890123"), [["ACCOUNT_NUMBER", "1234567890123"]]);
  assert.deepEqual(found("0x52908400098527886E0F7030069857D2E4169EE7"), [["ACCOUNT_NUMBER", "0x52908400098527886E0F7030069857D2E4169EE7"]]);
});

test("AWS resource IDs, endpoints and bucket URIs are detected", () => {
  assert.deepEqual(found("instance i-0abc1234def567890 in vpc-0a1b2c3d with sg-12ab34cd"), [
    ["CLOUD_RESOURCE", "i-0abc1234def567890"],
    ["CLOUD_RESOURCE", "vpc-0a1b2c3d"],
    ["CLOUD_RESOURCE", "sg-12ab34cd"],
  ]);
  assert.deepEqual(found("host: payroll.cluster-c9x2.eu-west-1.rds.amazonaws.com"), [["CLOUD_RESOURCE", "payroll.cluster-c9x2.eu-west-1.rds.amazonaws.com"]]);
  assert.deepEqual(found("docker pull 123456789012.dkr.ecr.us-east-1.amazonaws.com/app"), [["CLOUD_RESOURCE", "123456789012.dkr.ecr.us-east-1.amazonaws.com"]]);
  assert.deepEqual(found("aws s3 cp s3://unicef-hr-exports/file.csv ."), [["CLOUD_RESOURCE", "s3://unicef-hr-exports/file.csv"]]);
  assert.deepEqual(found("https://unicef-hr.s3.amazonaws.com/a.pdf"), [["CLOUD_RESOURCE", "unicef-hr.s3.amazonaws.com"]]);
});

test("AWS credentials are detected, including the unprefixed secret access key", () => {
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  assert.deepEqual(found(`aws_secret_access_key = ${secret}`), [["SECRET", secret]]);
  assert.deepEqual(found(`AWS_SECRET_ACCESS_KEY="${secret}"`), [["SECRET", secret]]);
  assert.deepEqual(found(`AKIAIOSFODNN7EXAMPLE and then ${secret} for the CLI`).sort(), [
    ["API_KEY", "AKIAIOSFODNN7EXAMPLE"],
    ["SECRET", secret],
  ]);
  assert.deepEqual(types("AIDAIOSFODNN7EXAMPLE"), ["API_KEY"]);
  assert.deepEqual(types("AIDAJQABLZS4A3QDU576Q"), ["API_KEY"]); // 21-character IAM unique ID
});

test("named secrets in JSON, YAML and headers are detected", () => {
  assert.deepEqual(found(`{"password": "Tr0ub4dor&3"}`), [["SECRET", "Tr0ub4dor&3"]]);
  assert.deepEqual(found("client_secret: a8Fk29xLq0Zp"), [["SECRET", "a8Fk29xLq0Zp"]]);
  assert.deepEqual(found("x-api-key: 9f8e7d6c5b4a"), [["SECRET", "9f8e7d6c5b4a"]]);
  const jwt = "Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456ghi789";
  assert.deepEqual(types(`Authorization: ${jwt}`), ["API_KEY"]);
  assert.deepEqual(found("curl 'https://api.x.com/v1?api_key=k3Jf93kdLs02&page=2'"), [["SECRET", "k3Jf93kdLs02"]]);
  assert.deepEqual(found("DefaultEndpointsProtocol=https;AccountKey=" + "Ab1+".repeat(11) + "=="), [["SECRET", "Ab1+".repeat(11) + "=="]]);
});

test("one finding is reported when two detectors match the same value", () => {
  assert.deepEqual(found("password: hunter2!x"), [["SECRET", "hunter2!x"]]);
});

test("URLs with credentials, data services, internal hosts and share links are private", () => {
  const dsn = "postgres://admin:S3cretPw@db.prod.example-corp.com:5432/payroll";
  assert.deepEqual(found(`DATABASE_URL=${dsn}`), [["PRIVATE_URL", dsn]]);
  assert.deepEqual(found("mongodb+srv://cluster0.abcde.mongodb.net/app"), [["PRIVATE_URL", "mongodb+srv://cluster0.abcde.mongodb.net/app"]]);
  assert.deepEqual(found("see https://wiki.corp/page"), [["PRIVATE_URL", "https://wiki.corp/page"]]);
  assert.deepEqual(found("https://jira.unicef.internal/browse/X-1"), [["PRIVATE_URL", "https://jira.unicef.internal/browse/X-1"]]);
  assert.deepEqual(found("https://unicef.atlassian.net/wiki/spaces/HR"), [["PRIVATE_URL", "https://unicef.atlassian.net/wiki/spaces/HR"]]);
  const doc = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit";
  assert.deepEqual(found(`notes: ${doc}`), [["PRIVATE_URL", doc]]);
  assert.equal(isPrivateUrl("https://docs.google.com/document/"), false);
  assert.equal(isPrivateUrl("https://api.slack.com/methods"), false);
  assert.equal(isPrivateUrl("https://user:pass@example.com/"), false);
  assert.equal(isPrivateUrl("https://bob:Zx81kq@example.org/"), true); // real-looking password, even on a reserved domain
  assert.equal(isPrivateUrl("https://bob:Zx81kq@host.acme.io/"), true);
});

test("IPv6 and MAC addresses are detected; times and C++ scopes are not", () => {
  assert.deepEqual(found("ping 2001:db8:85a3::8a2e:370:7334 now"), [["IP_ADDRESS", "2001:db8:85a3::8a2e:370:7334"]]);
  assert.deepEqual(found("inet6 fe80::1ff:fe23:4567:890a"), [["IP_ADDRESS", "fe80::1ff:fe23:4567:890a"]]);
  assert.deepEqual(found("[2001:db8::1]:8080"), [["IP_ADDRESS", "2001:db8::1"]]);
  assert.equal(isValidIpv6("::1"), false);
  assert.equal(isValidIpv6("a::b"), false);
  assert.equal(isValidIpv6("12:30:45"), false);
  assert.deepEqual(found("eth0 3c:22:fb:1a:2b:3c up"), [["MAC_ADDRESS", "3c:22:fb:1a:2b:3c"]]);
  assert.deepEqual(found("ff:ff:ff:ff:ff:ff"), []);
});

test("internal hostnames are detected", () => {
  assert.deepEqual(found("ssh into db01.prod.corp tonight"), [["INTERNAL_HOST", "db01.prod.corp"]]);
  assert.deepEqual(found("curl api.payments.svc.cluster.local"), [["INTERNAL_HOST", "api.payments.svc.cluster.local"]]);
  assert.deepEqual(found("macbook-pro.local"), [["INTERNAL_HOST", "macbook-pro.local"]]);
});

test("usernames inside file paths are detected; generic accounts are not", () => {
  assert.deepEqual(found("File /Users/mominababar/unicef/privy/app.js line 3"), [["USERNAME", "mominababar"]]);
  assert.deepEqual(found(String.raw`C:\Users\Ayesha.Khan\Documents\x.docx`), [["USERNAME", "Ayesha.Khan"]]);
  assert.deepEqual(found("cd /home/jdoe42/projects"), [["USERNAME", "jdoe42"]]);
  assert.deepEqual(found("/home/ubuntu/app and /Users/Shared/Library and /home/runner/work"), []);
});

test("government IDs are detected by format or label", () => {
  assert.equal(isValidSsn("123-45-6789"), true);
  assert.equal(isValidSsn("987-65-4321"), false);
  assert.deepEqual(found("SSN 123-45-6789"), [["NATIONAL_ID", "123-45-6789"]]);
  assert.deepEqual(found("CNIC 35202-1234567-1"), [["NATIONAL_ID", "35202-1234567-1"]]);
  assert.deepEqual(found("my CNIC is 3520212345671"), [["NATIONAL_ID", "3520212345671"]]);
  assert.deepEqual(found("passport number: AB1234567"), [["NATIONAL_ID", "AB1234567"]]);
  assert.deepEqual(found("social security number is 123456789"), [["NATIONAL_ID", "123456789"]]);
});

test("Azure and GCP identifiers are detected from labels", () => {
  const guid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  assert.deepEqual(found(`tenant_id: ${guid}`), [["CLOUD_ACCOUNT_ID", guid]]);
  assert.deepEqual(found(`subscription id ${guid}`), [["CLOUD_ACCOUNT_ID", guid]]);
  assert.deepEqual(found("gcloud config set --project unicef-hr-prod-1234"), [["CLOUD_ACCOUNT_ID", "unicef-hr-prod-1234"]]);
  assert.deepEqual(found("project id should be unique"), []);
});

test("new token formats are detected", () => {
  assert.deepEqual(types("glpat-" + "a1B2c3D4e5F6g7H8i9J0"), ["API_KEY"]);
  assert.deepEqual(types("npm_" + "a1B2".repeat(9)), ["API_KEY"]);
  assert.deepEqual(types("https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/abcDEF123456xyz"), ["API_KEY"]);
});
