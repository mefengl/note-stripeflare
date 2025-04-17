# Stripeflare

Minimal demo to add Stripe Payments to a Cloudflare Worker

[![uithub.com](https://www.google.com/s2/favicons?domain=uithub.com&sz=16) 1600 tokens](https://uithub.com/janwilmake/stripeflare)

# Setup

1. Create a Stripe account
2. Navigate to https://dashboard.stripe.com/apikeys
3. Fill your publishable key and secret key in `.dev.vars`
4. Create a webhook at https://dashboard.stripe.com/webhooks/create. Endpoint URL: https://yourdomain.com/stripe-webhook
5. Fill your webhook singing secret in `.dev.vars`
6. Create a payment link at https://dashboard.stripe.com/payment-links
7. Fill the ID in `.dev.vars` (can be found in the URL, https://dashboard.stripe.com/payment-links/plink_SOMETHING) e.g. `plink_1REsLrHdjTpW3q7imVymkkkkk`
8. Now you're ready to receive payments and perform logic after the payment succeeded. See [main.ts](main.ts) (200 lines) and add your logic there to give the user what they paid for.
