// Payments are not connected yet. This module is the one place a provider plugs in, so nothing
// else in the app needs to change when Stripe, Razorpay or another provider is chosen.
//
// A provider is an object:
//   {
//     name: "stripe",
//     enabled: true,
//     createCheckoutSession({ client, owner, planKey, successUrl, cancelUrl }) -> { url }
//     createPortalSession({ client, returnUrl })                              -> { url }
//   }
// plus a webhook route that updates Client.plan and Client.subscription when a payment succeeds,
// fails or is canceled. Choose it with BILLING_PROVIDER in .env and register it below.

const noProvider = { name: "none", enabled: false };

const PROVIDERS = {
  none: noProvider,
  // stripe: stripeProvider,
};

export const getBillingProvider = () => {
  const name = (process.env.BILLING_PROVIDER || "none").toLowerCase();
  const provider = PROVIDERS[name];

  if (!provider) {
    console.warn(`Unknown BILLING_PROVIDER "${name}": online payments stay disabled`);
    return noProvider;
  }
  return provider;
};
