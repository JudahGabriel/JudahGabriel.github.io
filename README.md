# Personal site

GitHub Pages builds the root of `main` with Jekyll. The activity workflow runs every
twelve hours and can also be run manually from Actions. It collects public GitHub
activity, RSS blog posts, and optionally X posts and reposts. No visitor-side API calls.

## Optional paid X feed

Create an X developer app owned by the account `judahgabriel`, with read access and
OAuth 1.0a user-context credentials. Add these **repository Actions secrets**:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

Set **repository Actions variable** `X_USER_ID` to the account's numeric ID (not its
handle). Obtain it once with an authenticated, OAuth-signed
`GET https://api.x.com/2/users/by/username/judahgabriel` request in your API client.
This lookup may be billed. Do not commit credentials or put them in the variable.
The scheduled job never calls a user-lookup endpoint.

Without all five settings, X is skipped and the other feeds continue working.
Setting them enables paid reads on the next scheduled or manual refresh.
Authentication, credit/rate-limit, and network failures preserve cached X items.

The job makes **at most one timeline request per run**, with `max_results=10`,
excluding replies but including reposts. It stores the newest event ID in
`_data/activity.json` and sends `since_id` thereafter; do not delete that cursor
unless you intend to fetch/bill recent posts again. It retains up to 30 X items.
It does not paginate: if more than 10 events arrive between runs, older unseen
events may be skipped. Expansions retrieve original repost text without a second
request; repost links open the original post on X.

At the published Owned Read rate of **$0.001 per returned post**, 2 runs/day with
10 timeline posts/run is about **$0.60 per 30-day month** before any additional
expanded-post or other charges. With incremental reads and less activity, it
should be lower. At the current standard $0.005/post rate, ten additional
expanded reposts per run could add about $3/month (about $3.60 total).
This is an estimate, **not a spending cap**: X pricing,
deduplication, expanded repost billing, and app eligibility can affect the bill.
Configure spending controls/credits in the X developer console.
See [X pricing](https://docs.x.com/x-api/getting-started/pricing).

Run regression tests with `node --test scripts/*.test.mjs`.
