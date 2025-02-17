// @ts-check
import { join } from 'path';
import { readFileSync } from 'fs';
import express from 'express';
import cookieParser, { signedCookie } from 'cookie-parser';
import { Shopify, LATEST_API_VERSION } from '@shopify/shopify-api';

import applyAuthMiddleware from './middleware/auth.js';
import verifyRequest from './middleware/verify-request.js';
import { setupGDPRWebHooks } from './gdpr.js';
import redirectToAuth from './helpers/redirect-to-auth.js';
import { AppInstallations } from './app_installations.js';

import 'dotenv/config';
// import { Template } from './schemas/template.js';
import mongoose from 'mongoose';
const TemplateSchema = new mongoose.Schema(
	{
		name: { type: String },

		data: [{}],
	},
	{ strict: false }
);
const Template = mongoose.model('Template', TemplateSchema);

mongoose.connect(process.env.MONGO_URI, (err, res) => {
	if (err) {
		console.log(err);
	} else {
		console.log('Connected to DB');
	}
});

const USE_ONLINE_TOKENS = false;

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT, 10);

// TODO: There should be provided by env vars
const DEV_INDEX_PATH = `${process.cwd()}/frontend/`;
const PROD_INDEX_PATH = `${process.cwd()}/frontend/dist/`;

const DB_PATH = `${process.cwd()}/database.sqlite`;

Shopify.Context.initialize({
	API_KEY: process.env.SHOPIFY_API_KEY,
	API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
	SCOPES: process.env.SCOPES.split(','),
	HOST_NAME: process.env.HOST.replace(/https?:\/\//, ''),
	HOST_SCHEME: process.env.HOST.split('://')[0],
	API_VERSION: LATEST_API_VERSION,
	IS_EMBEDDED_APP: false,
	// This should be replaced with your preferred storage strategy
	SESSION_STORAGE: new Shopify.Session.SQLiteSessionStorage(DB_PATH),
});

Shopify.Webhooks.Registry.addHandler('APP_UNINSTALLED', {
	path: '/api/webhooks',
	webhookHandler: async (_topic, shop, _body) => {
		await AppInstallations.delete(shop);
	},
});

// The transactions with Shopify will always be marked as test transactions, unless NODE_ENV is production.
// See the ensureBilling helper to learn more about billing in this template.
const BILLING_SETTINGS = {
	required: false,
	// This is an example configuration that would do a one-time charge for $5 (only USD is currently supported)
	// chargeName: "My Shopify One-Time Charge",
	// amount: 5.0,
	// currencyCode: "USD",
	// interval: BillingInterval.OneTime,
};

// This sets up the mandatory GDPR webhooks. You’ll need to fill in the endpoint
// in the “GDPR mandatory webhooks” section in the “App setup” tab, and customize
// the code when you store customer data.
//
// More details can be found on shopify.dev:
// https://shopify.dev/apps/webhooks/configuration/mandatory-webhooks
setupGDPRWebHooks('/api/webhooks');

// export for test use only
export async function createServer(
	root = process.cwd(),
	isProd = process.env.NODE_ENV === 'production',
	billingSettings = BILLING_SETTINGS
) {
	const app = express();

	app.set('use-online-tokens', USE_ONLINE_TOKENS);
	app.use(cookieParser(Shopify.Context.API_SECRET_KEY));

	applyAuthMiddleware(app, {
		billing: billingSettings,
	});

	// Do not call app.use(express.json()) before processing webhooks with
	// Shopify.Webhooks.Registry.process().
	// See https://github.com/Shopify/shopify-api-node/blob/main/docs/usage/webhooks.md#note-regarding-use-of-body-parsers
	// for more details.
	app.post('/api/webhooks', async (req, res) => {
		try {
			await Shopify.Webhooks.Registry.process(req, res);
			console.log(`Webhook processed, returned status code 200`);
		} catch (e) {
			console.log(`Failed to process webhook: ${e.message}`);
			if (!res.headersSent) {
				res.status(500).send(e.message);
			}
		}
	});

	// All endpoints after this point will require an active session
	app.use(
		'/api/*',
		verifyRequest(app, {
			billing: billingSettings,
		})
	);

	app.get('/api/session', async (req, res) => {
		const session = await Shopify.Utils.loadCurrentSession(
			req,
			res,
			app.get('use-online-tokens')
		);
		let status = 200;
		let error = null;
		res.status(status).send({ success: status === 200, error, session });
	});

	// All endpoints after this point will have access to a request.body
	// attribute, as a result of the express.json() middleware
	app.use(express.json());

	app.use((req, res, next) => {
		const shop = Shopify.Utils.sanitizeShop(req.query.shop);
		if (Shopify.Context.IS_EMBEDDED_APP && shop) {
			res.setHeader(
				'Content-Security-Policy',
				`frame-ancestors https://${encodeURIComponent(
					shop
				)} https://admin.shopify.com;`
			);
		} else {
			res.setHeader('Content-Security-Policy', `frame-ancestors 'none';`);
		}
		next();
	});

	if (isProd) {
		const compression = await import('compression').then(
			({ default: fn }) => fn
		);
		const serveStatic = await import('serve-static').then(
			({ default: fn }) => fn
		);
		app.use(compression());
		app.use(serveStatic(PROD_INDEX_PATH, { index: false }));
	}

	// API
	app.post('/api/template', async (req, res) => {
		const sid = req.query.shop;
		if (!req.body || !req.body.template) {
			res.send('Insufficient Data');
			return;
		}
		const resp = await Template.create({
			shop: sid,
			name: req.body.name,
			template: req.body.template,
		});
		res.send(resp);
	});

	app.patch('/api/template', async (req, res) => {
		const sid = req.query.shop;
		if (!req.body || !req.body.template) {
			res.send('Insufficient Data');
			return;
		}
		const resp = await Template.findOneAndUpdate(
			{ shop: sid, name: req.body.name },
			{
				shop: sid,
				name: req.body.name,
				template: req.body.template,
			}
		);
		res.send(resp);
	});

	// get template of that shop having this name
	app.get('/api/template/:id', async (req, res) => {
		const sid = req.query.shop;
		const resp = await Template.find({ shop: sid, name: req.params.id });
		res.send(resp);
	});

	// delete the template of given id/name
	app.delete('/api/template/:id', async (req, res) => {
		const sid = req.query.shop;
		const resp = await Template.findOneAndDelete({
			shop: sid,
			name: req.params.id,
		});
		res.send(resp);
	});

	// check duplicate (return the template if exists in db)
	app.post('/api/templates/dup', async (req, res) => {
		const sid = req.query.shop;
		const resp = await Template.find({ shop: sid, name: req.body.name });
		res.send(resp);
	});

	// return all templates belonging to that shop
	app.get('/api/templates', async (req, res) => {
		const sid = req.query.shop;
		const resp = await Template.find({ shop: sid });
		res.send(resp);
	});

	app.use('/*', async (req, res, next) => {
		if (typeof req.query.shop !== 'string') {
			res.status(500);
			return res.send('No shop provided');
		}

		const shop = Shopify.Utils.sanitizeShop(req.query.shop);
		const appInstalled = await AppInstallations.includes(shop);

		if (!appInstalled) {
			return redirectToAuth(req, res, app);
		}

		// if (Shopify.Context.IS_EMBEDDED_APP && req.query.embedded !== '1') {
		// 	const embeddedUrl = Shopify.Utils.getEmbeddedAppUrl(req);

		// 	return res.redirect(embeddedUrl + req.path);
		// }

		const htmlFile = join(
			isProd ? PROD_INDEX_PATH : DEV_INDEX_PATH,
			'index.html'
		);

		return res
			.status(200)
			.set('Content-Type', 'text/html')
			.send(readFileSync(htmlFile));
	});

	return { app };
}

createServer().then(({ app }) => app.listen(PORT));
