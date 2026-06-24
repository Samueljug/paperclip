# Implicit Requirements Checklist for Legal AI Platforms

When analysing a ticket, run through this checklist for every explicit requirement. These are the things tickets almost never mention but almost always need. If a requirement on this list applies to the feature being built, add it to the "Implicit Requirements" section of the discover output.

## Error Handling and Resilience

- What happens when the user submits invalid input? Is there a validation message?
- What happens when an API call fails? Is there a retry? A fallback? An error message?
- What happens when the database query returns no results? Does the UI show an empty state or break?
- What happens when a required field is null or undefined in the database? Does the code handle it gracefully?
- What happens during a network timeout? Does the user know something went wrong?
- What happens if a third-party service (Stripe, Smokeball, AWS) is temporarily unavailable?
- Are there any race conditions? (Two users editing the same document, concurrent API calls, double-click on submit)

## User Experience States

- Loading state: When data is being fetched, does the user see a spinner, skeleton screen, or loading indicator?
- Empty state: When there's no data to show (new account, no templates, no results), is there a helpful empty state?
- Error state: When something goes wrong, does the user see a clear error message with guidance on what to do?
- Success state: After a successful action (save, create, delete), does the user get confirmation?
- Partial state: If a multi-step process fails halfway through, what does the user see? Can they retry?
- Disabled state: Are buttons/actions disabled when they shouldn't be clickable (during loading, when permissions don't allow it)?

## Security and Access Control

- Does this feature need authentication? (Almost everything does)
- Does this feature need authorisation beyond just "logged in"? (Admin-only actions, firm-owner actions, role-specific actions)
- Does the data returned need to be scoped to the current tenant/firm? (Almost always yes)
- Are there any new user inputs that need sanitisation to prevent XSS, SQL injection, or command injection?
- If there are file uploads, are they validated for type, size, and content?
- Does this feature expose any data that shouldn't be visible to certain user roles?
- Should actions on this feature be rate-limited to prevent abuse?

## Audit and Compliance

- Does this action need to be logged for audit purposes? (Document changes, permission changes, billing changes, login events — these almost always need audit trails for legal platforms)
- Does this feature process or display personally identifiable information (PII)?
- Does this feature need to comply with data retention policies?
- If this feature involves document generation, does the generated output need to be stored as a record?
- Does this feature need to maintain a history of changes (version history, edit trail)?

## Multi-Tenancy

- Is every database query in this feature properly scoped to the current firm/tenant?
- If this feature has a listing or search, can it ever return results from another firm?
- If this feature involves file storage, are files stored in tenant-isolated paths?
- If this feature has caching, is the cache keyed by tenant to prevent cross-tenant data leakage?
- If this feature sends emails or notifications, are they scoped to the correct firm's users?

## Data Integrity

- If this feature creates or modifies records, what happens if the operation partially fails? Is there a transaction or rollback?
- If this feature deletes data, is it a soft delete (flagged as deleted) or hard delete? Which is appropriate?
- Are there any cascade effects? (Deleting a firm should delete its users, templates, documents, etc.)
- If this feature modifies data that other features read, will those other features handle the modified shape correctly?
- Are there any constraints or uniqueness requirements on new fields? (e.g., email addresses must be unique per firm)

## Performance and Scale

- If this feature involves a list or table, what happens when there are 10,000 items? Is there pagination?
- If this feature involves a database query, will it perform well at scale? Does it need an index?
- If this feature involves file uploads, is there a size limit? What happens when someone uploads a 500MB file?
- If this feature involves real-time updates (WebSockets, polling), what's the load at scale?
- If this feature runs a background job, what happens if the job fails? Is there retry logic?

## Internationalisation and Localisation

- Does this feature display dates? Are they formatted for the user's locale (AU: DD/MM/YYYY, not US: MM/DD/YYYY)?
- Does this feature handle currency? Is GST calculated correctly for Australian firms?
- Does this feature handle timezone-sensitive data? (Deadlines, court dates, filing dates)
- Does this feature have hardcoded strings that should be in a translation file?
- Does this feature handle jurisdiction-specific legal terminology? (Different Australian states have different terms for the same legal concepts)

## Backwards Compatibility

- If this changes an API endpoint, will existing clients (web app, mobile app, integrations) still work?
- If this changes a database schema, will the old code still work during a rolling deployment? (The old version of the app will still be running during deployment)
- If this introduces a new required field, what happens to existing records that don't have it?
- If this changes the shape of cached data, will the old cache entries cause errors?
- If this changes event/webhook payloads, will existing consumers handle the new shape?

## Testing Requirements

- Does this feature need unit tests? (Almost always yes)
- Does this feature need integration tests? (If it touches APIs or databases, yes)
- Does this feature need end-to-end tests? (If it involves user flows across multiple pages, yes)
- Does this feature need business logic tests that verify actual outcomes? (If it involves calculations, pricing, permissions, or conditional logic, yes)
- Are there regression risks? (Could these changes break existing features that aren't directly related?)

## Deployment and Rollout

- Can this feature be deployed behind a feature flag for gradual rollout?
- If the deployment fails, can this change be rolled back without data loss?
- Does this feature need database migrations? If so, are they safe to run on a live database?
- Does this feature need any infrastructure changes (new environment variables, new AWS resources, new DNS entries)?
- Does this feature need any manual steps after deployment (data backfill, cache clear, config update)?
