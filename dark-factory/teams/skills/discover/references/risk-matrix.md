# Risk Matrix for Legal AI Platform Development

Use this matrix to categorise risks identified during ticket discovery. Every change should be classified into one of three tiers. When in doubt, escalate to the higher tier — the cost of over-cautioning is a short conversation; the cost of under-cautioning is a production incident affecting law firm data.

## Critical Risk — Requires Team Lead Sign-off Before Proceeding

These areas directly affect data integrity, client confidentiality, or regulatory compliance. A mistake here doesn't just create a bug — it creates a potential breach, legal liability, or loss of client trust.

**Authentication and authorisation changes:**
- Modifications to login flows, session handling, or token validation
- Changes to middleware that checks user identity or permissions
- New endpoints or routes that need auth but might be missing it
- Changes to role definitions or permission hierarchies
- Modifications to password reset, MFA, or account recovery flows

**Tenant isolation changes:**
- Any database query that filters by firm ID, organisation ID, or tenant ID
- Changes to data access layers that scope results to a specific tenant
- New API endpoints that return data — verify they filter by tenant
- Changes to file storage or document access paths
- Modifications to search or listing functionality that could leak cross-tenant data

**Billing and subscription logic:**
- Changes to pricing calculations, plan definitions, or tier gating
- Modifications to Stripe integration or payment processing
- Changes to trial logic, upgrade/downgrade flows, or usage metering
- Any code that determines what features a firm can access based on their plan
- Invoice generation or billing email changes

**Data sovereignty compliance:**
- Any new external API call or third-party service integration
- Changes to infrastructure configuration or deployment regions
- New data processing pipelines or ETL jobs
- Changes to where documents, user data, or logs are stored
- Introduction of any service that might route data outside ap-southeast-2

**External API contracts:**
- Changes to response shapes on endpoints consumed by Smokeball or other integrations
- Modifications to webhook payloads or event formats
- Changes to API authentication methods for external consumers
- Deprecation or removal of any API endpoint

## High Risk — Requires Extra Care and Thorough Testing

These areas are important but less likely to cause immediate regulatory or trust impact. They still need careful attention because bugs here affect multiple users or are hard to revert.

**Database schema changes:**
- New collections, tables, or fields
- Index creation or removal (especially on large collections)
- Migration scripts that modify existing data
- Changes to field types, constraints, or defaults
- Removal of fields that might still be referenced elsewhere

**Shared code modifications:**
- Changes to utility functions imported by 5+ files
- Modifications to base classes or abstract implementations
- Changes to shared middleware or request/response interceptors
- Updates to shared validation schemas or DTOs
- Modifications to event bus, message queue, or pub/sub handlers

**Document generation and legal templates:**
- Changes to template rendering logic
- Modifications to jurisdiction-specific content
- Changes to document formatting, headers, footers, or metadata
- Updates to clause libraries or precedent databases
- Changes to PDF generation or export functionality

**User-facing permissions:**
- Changes to what actions different user roles can perform
- Modifications to UI elements that show/hide based on permissions
- Changes to admin panel functionality
- Updates to invitation, onboarding, or team management flows

**Third-party integrations:**
- New API integrations with external services
- Changes to OAuth flows or credential management
- Modifications to data sync or import/export functionality
- Updates to webhook receivers or event handlers

## Standard Risk — Follow Normal Development Practices

These changes have limited blast radius and are straightforward to test and revert.

- New UI components with no shared dependencies
- Internal-only API endpoints with no external consumers
- Styling and layout changes
- Copy/text updates
- Configuration file changes (that don't affect infrastructure)
- Documentation updates
- Test file additions or modifications
- Development tooling changes (linting rules, build config, CI scripts)
- Logging changes (that don't log sensitive data)
- Performance optimisations to isolated functions

## How to Use This Matrix

1. During the discovery phase, classify every identified change into one of the three tiers.
2. If ANY change falls into Critical, the "MUST CLARIFY BEFORE STARTING" section of the discover output should include a note that team lead sign-off is required.
3. If changes fall into High Risk, the output should recommend extra test coverage and careful review for those specific areas.
4. When in doubt about classification, check: "If this went wrong in production, who would notice and how fast?" If the answer is "a law firm's client data would be exposed" or "billing would be incorrect," it's Critical.
