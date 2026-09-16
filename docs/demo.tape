# The README GIF. Regenerate with:  vhs docs/demo.tape
# Needs `npm run dev` (wrangler dev --local --port 8787) already running.
Output "docs/demo.gif"

Set Shell "bash"
Set FontSize 16
Set Width 1180
Set Height 640
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 28ms

Hide
Type `export PATH=/opt/homebrew/bin:$PATH; export PS1='$ '; clear`
Enter
Show

Sleep 700ms
Type `# 1. Ask for a check without paying.`
Enter
Sleep 600ms
Type `curl -si 'localhost:8787/v1/check?url=https://example.com' | head -1`
Enter
Sleep 2s

Type `# The price rides in the PAYMENT-REQUIRED header, not the body. That is x402 v2.`
Enter
Sleep 600ms
Type `curl -s -D - -o /dev/null 'localhost:8787/v1/check?url=https://example.com' | grep -i ^payment-required | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq -c '.accepts[0] | {network, amount, asset, payTo}'`
Enter
Sleep 4s

Type `clear`
Enter
Sleep 300ms
Type `# 2. The free demo runs the same check on a host we own.`
Enter
Sleep 600ms
Type `curl -s localhost:8787/demo | jq -c '{host: .target.host, grade: .verdict.grade, score: .verdict.score}'`
Enter
Sleep 3s

Type `# Every issue it names is true. Nothing is invented.`
Enter
Sleep 400ms
Type `curl -s localhost:8787/demo | jq -c '[.verdict.issues[].code]'`
Enter
Sleep 3s

Type `clear`
Enter
Sleep 300ms
Type `# 3. The same three checks are MCP tools, behind the same paywall.`
Enter
Sleep 600ms
Type `curl -s localhost:8787/mcp -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -c '[.result.tools[].name]'`
Enter
Sleep 3s

Type `# Presence is not proof. A made-up payment is refused, and the site is never fetched.`
Enter
Sleep 600ms
Type `curl -s localhost:8787/mcp -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_url","arguments":{"url":"https://example.com","payment":"bogus"}}}' | jq -r '.result.content[0].text' | jq -c '{x402, reason}'`
Enter
Sleep 4s
