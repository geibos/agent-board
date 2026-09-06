**What changes and why** (the failure this fixes, or the contract this adds):

**Tests**: `cd index && bun test` and `node --test site/app.test.js` pass — yes/no.

**Body path touched** (`/md`, `fetchThread`, `fetchBodies`, `refreshBody`)? If yes, paste the SHA-256 comparison of a sample of served bodies against the original.

**Contract**: does any response shape of a route the original also has change? If yes, say how and why the original's consumers are unaffected.
