# 代码阅读推荐顺序

- [`index.html`](./index.html)
- [`main.ts`](./main.ts)
- [`package.json`](./package.json)
- [`wrangler.jsonc`](./wrangler.jsonc)
- [`README.md`](./README.md)
- [`.assetsignore`](./.assetsignore)

---

## Stripeflare

Minimal demo to add Stripe Payments to a Cloudflare Worker

[![janwilmake/stripeflare context](https://badge.forgithub.com/janwilmake/stripeflare)](https://uithub.com/janwilmake/stripeflare) [![XyMake Build Status](https://badge.xymake.com/janwilmake/status/1912873192160375230)](https://xymake.com/janwilmake/status/1912873192160375230)

## Project Overview (项目概述)

- `index.html`: 一个简单的 HTML 页面，包含一个 Stripe 付款按钮，用户点击后会跳转到 Stripe Checkout 页面。
- `main.ts`: Cloudflare Worker 的核心逻辑。它监听来自 Stripe 的 Webhook 事件 (特别是支付成功事件)，验证请求，并包含处理支付成功后业务逻辑的占位符。
- `package.json`: 定义项目依赖 (主要是 Stripe Node.js 库)。
- `wrangler.jsonc`: Cloudflare Wrangler CLI 的配置文件，用于定义 Worker 名称、路由、构建设置等。
- `.dev.vars` (你需要自行创建): 用于 **本地开发** 时存储敏感信息 (API 密钥等) 的文件。**注意：此文件不应提交到 Git 仓库！**

## Setup (设置步骤)

你需要一个 Stripe 账户和一个 Cloudflare 账户来运行此项目。

1. **创建 Stripe 账户**: 如果你还没有，请访问 [Stripe](https://stripe.com/) 注册。
2. **获取 Stripe API 密钥**:
   - 导航到 Stripe Dashboard 的 [API Keys](https://dashboard.stripe.com/apikeys) 页面。
   - 你会看到 **Publishable key** (可发布密钥，类似 `pk_test_...`) 和 **Secret key** (秘密密钥，类似 `sk_test_...`)。
3. **创建 `.dev.vars` 文件 (用于本地开发)**:
   - 在项目根目录创建一个名为 `.dev.vars` 的文件。
   - 将你的 Stripe 密钥填入其中，格式如下：

     ```bash
     STRIPE_SECRET=sk_test_YOUR_SECRET_KEY
     STRIPE_PUBLISHABLE_KEY=pk_test_YOUR_PUBLISHABLE_KEY
     # 稍后我们还会添加 STRIPE_WEBHOOK_SIGNING_SECRET 和 STRIPE_PAYMENT_LINK_ID
     ```

   - **重要**: `.dev.vars` **仅用于本地测试** (`wrangler dev`)。部署到生产环境时，你需要使用 `wrangler secret put` 命令或在 Cloudflare Dashboard 中设置 Secrets (见 "Deployment" 部分)。**切勿将包含真实密钥的 `.dev.vars` 文件提交到 Git！** 建议将 `.dev.vars` 加入 `.gitignore` 文件。
4. **创建 Stripe Webhook Endpoint**:
   - 访问 Stripe Dashboard 的 [Webhooks](https://dashboard.stripe.com/webhooks/create) 页面，点击 "Add endpoint"。
   - **Endpoint URL**: 这里需要填入你的 Worker 处理 Webhook 的 URL。
     - **如果你使用自定义域 (在 `wrangler.jsonc` 中配置了)**: 填入 `https://<你的域名>/stripe-webhook` (例如 `https://stripeflare.com/stripe-webhook`)。
     - **如果你使用 Cloudflare 提供的 `*.workers.dev` 域名**: 运行 `wrangler deploy` (即使只是为了获取 URL) 或在 Cloudflare Dashboard 中查看你的 Worker URL，然后填入 `https://<你的Worker名称>.<你的子域>.workers.dev/stripe-webhook` (例如 `https://stripeflare.myaccount.workers.dev/stripe-webhook`)。对于本地开发测试，可以使用 `wrangler dev --tunnel` 并将生成的 `cloudflared` URL (类似 `https://something.trycloudflare.com`) 填入，路径为 `/stripe-webhook`。
   - **Select events to listen to**: 点击 "Select events"，至少需要选择 `checkout.session.completed` 事件。你也可以根据需要添加其他事件 (如 `customer.subscription.*`)。
   - 点击 "Add endpoint"。
5. **获取 Webhook Signing Secret**:
   - 创建 Webhook Endpoint 后，在详情页面找到 "Signing secret" (签名密钥)，点击 "Reveal"。它看起来像 `whsec_...`。
   - 将这个值添加到你的 `.dev.vars` 文件中：

     ```bash
     STRIPE_WEBHOOK_SIGNING_SECRET=whsec_YOUR_SIGNING_SECRET
     ```

6. **创建 Stripe Payment Link**:
   - 访问 Stripe Dashboard 的 [Payment Links](https://dashboard.stripe.com/payment-links/create) 页面，创建一个简单的产品和价格，并生成一个支付链接。
   - 创建后，查看该支付链接的 URL，例如 `https://buy.stripe.com/test_...` 或 `https://donate.stripe.com/...`。**注意：我们需要的是支付链接 *本身* 的 ID，而不是链接的 URL**。这个 ID 通常可以在支付链接的管理页面找到，或者在创建后显示。它看起来像 `plink_...`。（**注意：此示例代码 `index.html` 中实际上没有直接使用 Payment Link ID，而是直接跳转到支付链接 URL。但 `main.ts` 中的逻辑可能预期验证它，因此保留此步骤以获取 ID 并配置。请检查 `main.ts` 的 `checkout.session.completed` 处理逻辑是否确实需要 `STRIPE_PAYMENT_LINK_ID` 环境变量进行验证。如果不需要，可以省略此步骤和相关环境变量。**）
   - 假设需要，将 Payment Link ID 添加到 `.dev.vars`：

     ```bash
     STRIPE_PAYMENT_LINK_ID=plink_YOUR_PAYMENT_LINK_ID
     ```

7. **更新 `index.html` 中的支付链接 URL**:
   - 打开 `index.html` 文件。
   - 找到 `redirectToCheckout` 函数中的 `url` 参数。
   - 将其替换为你 **实际创建的支付链接 URL** (例如 `https://buy.stripe.com/test_...`)。

     ```javascript
     // 在 index.html 中
     function redirectToCheckout() {
       stripe.redirectToCheckout({
         // !! 把下面这个 URL 换成你自己的支付链接 !!
         url: 'https://buy.stripe.com/test_YOUR_PAYMENT_LINK_URL', 
         // ... 其他参数
       }).then(function (result) {
         // ...
       });
     }
     ```

8. **添加业务逻辑**:
   - 设置完成后，当用户通过支付链接成功付款时，Stripe 会向你的 Webhook URL 发送 `checkout.session.completed` 事件。
   - 打开 `main.ts` 文件，找到处理此事件的代码块 (在 `switch (event.type)` 内部)。
   - 在那里添加你自己的业务逻辑，例如：给用户发送邮件、在数据库中标记用户为付费用户、解锁特定功能等。

## Running Locally (本地运行)

1. **安装依赖**:

   ```bash
   npm install 
   # 或者如果你使用 yarn: yarn install
   ```

2. **启动本地开发服务器**:

   ```bash
   npx wrangler dev
   ```

   这会启动一个本地服务器 (默认在 `http://localhost:3000`)，并加载 `.dev.vars` 中的环境变量。你可以访问这个 URL 来查看 `index.html` 页面并进行支付测试。Wrangler 也会监听文件变化并自动重新加载。

## Deployment (部署)

1. **设置生产 Secrets**:
   - **重要**: `.dev.vars` 不会用于部署。你需要将必要的 Secrets 安全地上传到 Cloudflare。
   - 打开你的终端，使用 `wrangler secret put` 命令逐个设置：

     ```bash
     npx wrangler secret put STRIPE_SECRET
     # (粘贴你的 Secret Key 并回车)
     
     npx wrangler secret put STRIPE_WEBHOOK_SIGNING_SECRET
     # (粘贴你的 Webhook Signing Secret 并回车)
     
     # 如果你的代码需要，也设置 PUBLISHABLE_KEY 和 PAYMENT_LINK_ID
     # npx wrangler secret put STRIPE_PUBLISHABLE_KEY 
     # npx wrangler secret put STRIPE_PAYMENT_LINK_ID 
     ```

   - 你也可以在 Cloudflare Dashboard 的 Worker 设置页面手动添加这些 Secrets。
2. **部署 Worker**:

   ```bash
   npx wrangler deploy
   ```

   这将构建你的 Worker 代码、上传静态资源 (如果配置了 `assets`)，并将 Worker 部署到 Cloudflare 的全球网络上。部署成功后，Wrangler 会显示你的 Worker 可以访问的 URL (通常是 `*.workers.dev` 地址，除非你配置了自定义域)。

现在，你的 Stripe 集成应该可以在生产环境工作了！
