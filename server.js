// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3001; // Vercel will manage this in production

// --- Initialize Services ---
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL ERROR: GEMINI_API_KEY is not defined.");
  // In a real deployment, you might want to prevent startup or have a health check fail
}
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Middleware ---
app.use(cors({
  origin: process.env.FRONTEND_URL, // Critical for allowing your frontend to call this backend
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Auth Middleware (to protect Gemini proxy routes)
const authenticateSupabaseUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      console.error('Supabase JWT verification error:', error?.message);
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    req.user = user; // Attach user to request object for use in route handlers
    next();
  } catch (err) {
    console.error('Internal server error during JWT verification:', err.message);
    return res.status(500).json({ error: 'Internal Server Error verifying token' });
  }
};

// Stripe webhook parser (must come before express.json() for this route)
app.post('/api/stripe-webhooks', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe Webhook Received:', event.type);

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      console.log('Checkout session completed:', session.id, 'Client Ref ID:', session.client_reference_id);
      if (session.client_reference_id && session.metadata && session.metadata.plan_id && session.customer && session.subscription) {
        const { error: updateError } = await supabaseAdmin
          .from('profiles')
          .update({
            plan_id: session.metadata.plan_id,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
            subscription_status: 'active',
          })
          .eq('id', session.client_reference_id);
        if (updateError) console.error('Supabase error updating profile after checkout:', updateError);
        else console.log(`Profile updated for user ${session.client_reference_id} to plan ${session.metadata.plan_id}`);
      } else {
        console.error('Missing critical data in checkout.session.completed event:', session);
      }
      break;
    case 'invoice.payment_succeeded':
      const invPaymentSucceeded = event.data.object;
       if (invPaymentSucceeded.subscription) {
          const { error } = await supabaseAdmin.from('profiles')
            .update({ subscription_status: 'active' })
            .eq('stripe_subscription_id', invPaymentSucceeded.subscription);
          if (error) console.error('Error updating profile on invoice.payment_succeeded:', error);
          else console.log('Profile status confirmed active for subscription:', invPaymentSucceeded.subscription);
      }
      break;
    case 'invoice.payment_failed':
       const invPaymentFailed = event.data.object;
        if (invPaymentFailed.subscription) {
            const { error } = await supabaseAdmin.from('profiles')
              .update({ subscription_status: 'past_due' })
              .eq('stripe_subscription_id', invPaymentFailed.subscription);
            if (error) console.error('Error updating profile on invoice.payment_failed:', error);
            else console.log('Profile status set to past_due for subscription:', invPaymentFailed.subscription);
        }
      break;
    case 'customer.subscription.updated':
      const subUpdated = event.data.object;
      let newPlanId = null;
      if (subUpdated.items && subUpdated.items.data.length > 0) {
          const stripePriceId = subUpdated.items.data[0].price.id;
          const { data: planData, error: planErr } = await supabaseAdmin
              .from('plans')
              .select('id')
              .eq('stripe_price_id_monthly', stripePriceId)
              .single();
          if (planData && !planErr) newPlanId = planData.id;
          else console.error('Could not map Stripe price ID to internal plan ID on sub update:', stripePriceId, planErr);
      }
      const { error: subUpdateErr } = await supabaseAdmin.from('profiles')
          .update({ subscription_status: subUpdated.status, plan_id: newPlanId || undefined })
          .eq('stripe_subscription_id', subUpdated.id);
      if (subUpdateErr) console.error('Error updating profile on customer.subscription.updated:', subUpdateErr);
      else console.log('Subscription updated in DB:', subUpdated.id, 'Status:', subUpdated.status, 'New Plan:', newPlanId);
      break;
    case 'customer.subscription.deleted':
      const subDeleted = event.data.object;
      const { error: subDeleteErr } = await supabaseAdmin.from('profiles')
          .update({ subscription_status: 'canceled', plan_id: 'free' }) // Revert to a free plan or null
          .eq('stripe_subscription_id', subDeleted.id);
      if (subDeleteErr) console.error('Error updating profile on customer.subscription.deleted:', subDeleteErr);
      else console.log('Subscription canceled in DB:', subDeleted.id);
      break;
    default:
      console.log(`Unhandled Stripe event type ${event.type}`);
  }
  res.json({ received: true });
});

// General JSON parser for other routes
app.use(express.json());

// --- API Routes ---
app.get('/api', (req, res) => {
  res.json({ message: "Hello from Generative CMS Pro Backend on Vercel!" });
});

// Stripe Create Checkout Session
app.post('/api/create-checkout-session', authenticateSupabaseUser, async (req, res) => { // Added authentication
  const { priceId, userEmail } = req.body;
  const userId = req.user.id; // User ID from authenticatedSupabaseUser middleware

  if (!priceId || !userId || !userEmail) {
    return res.status(400).json({ error: 'Missing priceId, userId, or userEmail.' });
  }

  let stripeCustomerId;
  const { data: profile } = await supabaseAdmin.from('profiles').select('stripe_customer_id').eq('id', userId).single();
  if (profile && profile.stripe_customer_id) stripeCustomerId = profile.stripe_customer_id;

  const { data: planData, error: planError } = await supabaseAdmin
    .from('plans').select('id').eq('stripe_price_id_monthly', priceId).single();

  if (planError || !planData) {
    console.error(`Backend: Could not find internal plan_id for Stripe priceId ${priceId}:`, planError);
    return res.status(500).json({ error: 'Internal server error: Plan mapping failed.' });
  }

  const sessionParams = {
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${process.env.FRONTEND_URL}/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.FRONTEND_URL}/auth?payment=cancelled`,
    client_reference_id: userId,
    metadata: { supabase_user_id: userId, plan_id: planData.id }, // Use your internal plan ID
    customer_email: stripeCustomerId ? undefined : userEmail, // Only if not existing customer
    customer: stripeCustomerId || undefined,
  };

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Stripe Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Gemini API Proxy Routes (Protected by authenticateSupabaseUser) ---
const geminiApiProxyHandler = async (req, res, geminiAction) => {
  try {
    const result = await geminiAction(req.body, req.user); // Pass user if needed by action
    res.json(result);
  } catch (error) {
    console.error('Gemini API Proxy Error:', error);
    const errorMessage = error.message || 'AI service error';
    const statusCode = (error.message && (error.message.includes('quota') || error.message.includes('RESOURCE_EXHAUSTED') || error.status === 429)) ? 429 : 500;
    res.status(statusCode).json({ error: errorMessage });
  }
};

app.post('/api/ai/generate-image', authenticateSupabaseUser, (req, res) => {
  geminiApiProxyHandler(req, res, async ({ prompt, title }) => {
    if (!prompt && !title) throw new Error('Prompt or title is required for image generation.');
    const imagePrompt = prompt || `Featured image for article titled: ${title}`;
    const imageResponse = await genAI.models.generateImages({
      model: 'imagen-3.0-generate-002',
      prompt: imagePrompt,
      config: { numberOfImages: 1, outputMimeType: 'image/jpeg' },
    });
    if (imageResponse?.generatedImages?.[0]?.image?.imageBytes) {
      return { imageUrl: `data:image/jpeg;base64,${imageResponse.generatedImages[0].image.imageBytes}` };
    }
    throw new Error('No image data received from AI.');
  });
});

app.post('/api/ai/suggest-names', authenticateSupabaseUser, (req, res) => {
  geminiApiProxyHandler(req, res, async ({ niche }) => {
    if (!niche) throw new Error('Niche is required.');
    const model = 'gemini-2.5-flash-preview-04-17';
    const fullPrompt = `Suggest 5 creative and brandable website names for a niche about: "${niche}". Return them as a JSON array of strings. Example: ["Name 1", "Name 2"]`;
    const response = await genAI.models.generateContent({ model, contents: fullPrompt, config: { responseMimeType: "application/json" } });
    let jsonStr = response.text.trim();
    const fenceMatch = jsonStr.match(/^```(\w*)?\s*\n?(.*?)\n?\s*```$/s);
    if (fenceMatch && fenceMatch[2]) jsonStr = fenceMatch[2].trim();
    const names = JSON.parse(jsonStr);
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) throw new Error("AI did not return a valid JSON array of strings for names.");
    return { names };
  });
});

app.post('/api/ai/suggest-keywords', authenticateSupabaseUser, (req, res) => {
    geminiApiProxyHandler(req, res, async ({ nicheOrTopic }) => {
        if (!nicheOrTopic) throw new Error('Niche or Topic is required.');
        const model = 'gemini-2.5-flash-preview-04-17';
        const prompt = `Generate a list of 10-15 relevant SEO keywords for content related to "${nicheOrTopic}". Return as a JSON array of strings.`;
        const response = await genAI.models.generateContent({ model, contents: prompt, config: { tools: [{googleSearch: {}}], responseMimeType: "application/json" } });
        let jsonStr = response.text.trim();
        const fenceMatch = jsonStr.match(/^```(\w*)?\s*\n?(.*?)\n?\s*```$/s);
        if (fenceMatch && fenceMatch[2]) jsonStr = fenceMatch[2].trim();
        const keywords = JSON.parse(jsonStr);
        if (!Array.isArray(keywords) || !keywords.every(k => typeof k === 'string')) throw new Error("AI did not return a valid JSON array of strings for keywords.");
        // Attach grounding metadata if available
        const groundingMetadata = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
        return { keywords, groundingMetadata: groundingMetadata || [] };
    });
});

app.post('/api/ai/generate-article', authenticateSupabaseUser, (req, res) => {
    geminiApiProxyHandler(req, res, async ({ keyword, niche }) => {
        if (!keyword || !niche) throw new Error('Keyword and Niche are required.');
        const model = 'gemini-2.5-flash-preview-04-17';
        const prompt = `
          Generate a detailed blog post about "${keyword}" within the niche of "${niche}".
          The article should be engaging, informative, and SEO-friendly.
          Provide a featured image prompt (16:9 aspect ratio) and 2-3 inline image prompts.
          Return the output as a single JSON object with the following structure:
          {
            "title": "Article Title",
            "body": "HTML content of the article body...",
            "featuredImagePrompt": "Prompt for the featured image...",
            "inlineImagePrompts": ["Prompt for inline image 1...", "Prompt for inline image 2..."]
          }
        `;
        const response = await genAI.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json" } });
        let jsonStr = response.text.trim();
        const fenceMatch = jsonStr.match(/^```(\w*)?\s*\n?(.*?)\n?\s*```$/s);
        if (fenceMatch && fenceMatch[2]) jsonStr = fenceMatch[2].trim();
        const articleParts = JSON.parse(jsonStr);
        // Add validation for articleParts structure if needed
        return { articleParts };
    });
});

// For local development, Express app listens on a port
// Vercel handles this differently for serverless functions, so `module.exports = app` is key.
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Backend server running locally on http://localhost:${PORT}`);
    console.log(`Frontend URL for CORS: ${process.env.FRONTEND_URL}`);
    console.log(`Stripe Webhook endpoint for local testing (e.g., with Stripe CLI): http://localhost:${PORT}/api/stripe-webhooks`);
  });
}

// Export the Express app for Vercel's runtime
module.exports = app;