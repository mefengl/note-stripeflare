# Stripeflare

Minimal demo to add Stripe Payments to a Cloduflare Worker

# Setup

1. Create a Stripe account
2. Navigate to https://dashboard.stripe.com/apikeys
3. Fill your publishable key and secret key in `.dev.vars`
4. Create a webhook at https://dashboard.stripe.com/webhooks/create
5. Fill your webhook singing secret in `.dev.vars`
6. Create a payment link at https://dashboard.stripe.com/payment-links
7. Fill the ID in `.dev.vars` (can be found in the URL, https://dashboard.stripe.com/payment-links/plink_SOMETHING) e.g. `plink_1REsLrHdjTpW3q7imVymkkkkk`

Endpoint URL: https://yourdomain.com/stripe-webhook
