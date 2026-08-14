# App-Type Tool Reference

Tool-specific commands for exercising each application type during QA.

## Web App

Use Hermes browser tools. Every interaction: navigate → snapshot → act →
verify → check console.

```
browser_navigate(url="http://localhost:3000/signup")
browser_snapshot()                    # get @eN refs for interactive elements
browser_type(ref="@e1", text="value") # fill form fields
browser_click(ref="@e2")              # click buttons/links
browser_vision(question="...")        # visual verification
browser_console()                     # check for JS errors after each action
browser_scroll(direction="down")      # scroll to reveal content
browser_press(key="Enter")            # keyboard interaction
```

## CLI Tool

Use `terminal`. Check exit code and stdout/stderr.

```
terminal(command="mycli create-user --email test@example.com --name 'Test User'")
# Expected: exit 0, stdout contains "User created"

terminal(command="mycli create-user --email '' --name ''")
# Expected: exit 1, stderr contains validation error
```

## API Service

Use `terminal` with `curl`. Check status code and response body.

```
terminal(command="curl -s -w '\\n%{http_code}' -X POST http://localhost:8000/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{\"email\":\"test@test.com\",\"password\":\"Pass123!\"}'")
# Expected: 201, body contains user_id

# Error case: 422 with validation errors in body
```

## Desktop App

Load `computer-use` skill, then use its tools for screenshots, clicks, typing.

```
skill_view(name="computer-use")
# Then use computer-use tools: screenshot, click, type, verify visual state
```

## Library/SDK

Use `execute_code` or `terminal` to import and exercise.

```
execute_code(code="""
from mylib import create_user
result = create_user(email="test@test.com", password="Pass123!")
assert result.success, f"Expected success, got error: {result.error}"
print("PASS: create_user works")
""")
```
