# Security Checklist

A focus checklist for the review agent: the security mistakes AI coding agents
most often introduce. Review every change against these alongside business-logic
correctness. Sources: [OWASP Top 10 for LLM Applications](https://safeguard.sh/resources/blog/owasp-top-10-llm-applications-explained),
the [AI Code Security Field Guide](https://www.novakit.ai/blog/ai-code-security-vulnerabilities),
and the [CWE Top 25 mapping for AI-generated code](https://safeguard.sh/resources/blog/mapping-ai-generated-code-risks-to-the-cwe-top-25).

## 1. Injection (SQL / command / code / path)

String concatenation or interpolation of untrusted input into a query, shell command,
`eval`, or template.

**Signal**: user input reaches a sink (`execute` / `exec` / `eval` / `open` / `format`)
without parameterization, escaping, or validation.

## 2. Prompt injection in agent tools

Untrusted text (a tool result, an email, a web page) is fed back to the model and can
override the operator's instructions.

**Signal**: a tool's output is read into context without delimiters, least-privilege
permissions, or an explicit "treat as data, not instructions" boundary.

## 3. Missing / insecure authorization (IDOR)

A handler fetches or mutates a resource by an object id from the request without
checking the caller owns or may access it.

**Signal**: `get(id)` / `update(id)` with an id taken straight from user input and no
ownership check.

## 4. SSRF

A "fetch this URL" helper or webhook that accepts an attacker-controlled URL and
requests it without validating the scheme/host or blocking private ranges.

**Signal**: `fetch(url)` / `requests.get(url)` where `url` is user-supplied.

## 5. Insecure deserialization

Untrusted bytes fed to a deserializer that can instantiate objects or execute code —
`pickle.loads`, `yaml.load`, `eval`, `new Function`, `JSON.parse` into a
prototype-polluted shape.

**Signal**: a serializer that constructs objects from an external payload.

## 6. Broken authentication / session / JWT

JWTs decoded without signature verification or `alg`/`exp` checks; weak or predictable
session tokens; credentials compared insecurely.

**Signal**: `jwt.decode(...)` without verification; a session token built from a
non-crypto PRNG or a hardcoded secret.

## 7. Hardcoded secrets / secrets in client bundles

API keys, passwords, tokens, or signing keys committed in source or shipped to the client.

**Signal**: a literal credential or private key in code that reaches the client or a repo.

## 8. Weak cryptography / weak randomness

MD5/SHA1 for passwords, ECB mode, hardcoded IV, no salt, or `Math.random()` for
security-critical tokens.

**Signal**: a deprecated hash for a secret, or a non-cryptographic PRNG feeding a token/key.

## 9. Path traversal / unsafe file operations

File paths built from user input without normalization; archive extraction that trusts
entry names (zip-slip); writes outside the intended directory.

**Signal**: `open(base + user_input)` or an extract loop that doesn't validate the resolved
path stays under the destination.

## 10. Information disclosure

Stack traces, internal paths, debug data, or secrets leaked to users or logs.

**Signal**: an error path that returns/logs `err.stack`, internal paths, or a secret.

## 11. Race conditions (TOCTOU)

"Check then act" on shared state (a file, a balance, a flag) without atomicity or locking,
so the check and the act can interleave.

**Signal**: a read → decide → write sequence on shared state with no lock/transaction.

## 12. Insecure dependencies

Using a library version with known vulnerabilities, or an unmaintained dependency.

**Signal**: a dependency pinned to an old/unpatched version or a known-CVE package.
