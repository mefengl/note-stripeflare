/**
 * 整个文件是 Cloudflare Worker 的代码，它就像一个在云端的微型服务器。
 * 主要功能是接收来自 Stripe 的通知（称为 Webhook），并在收到付款成功等事件时执行相应的操作。
 * 比如，当用户付款成功后，这个 Worker 可以自动给用户发送邮件、开通服务等。
 * 
 * 它使用了 TypeScript 编写，这是一种 JavaScript 的超集，增加了类型系统，让代码更健壮。
 */

// 从 'stripe' 库导入 Stripe 类。
// 这个库是 Stripe 官方提供的 Node.js 库，包含了与 Stripe API 交互所需的所有工具。
// Cloudflare Workers 环境兼容很多 Node.js API 和库。
import { Stripe } from "stripe";

// 定义一个类型别名 `Env`，用于描述我们的 Worker 可以访问的环境变量。
// 这些变量通常在 Cloudflare 的仪表盘或者 wrangler.toml/`.dev.vars` 文件中设置，包含敏感信息，如 API 密钥。
// 使用类型定义可以帮助我们确保代码正确地使用了这些变量，并提供代码提示。
type Env = {
  STRIPE_WEBHOOK_SIGNING_SECRET: string; // Stripe Webhook 签名密钥，用来验证收到的请求确实是 Stripe 发来的。
  STRIPE_SECRET: string;                 // Stripe 的私密 API 密钥 (Secret Key)，用于调用 Stripe API 进行操作，比如验证 Webhook、创建退款等。**极其重要，绝不能泄露！**
  STRIPE_PUBLISHABLE_KEY: string;        // Stripe 的可发布 API 密钥 (Publishable Key)，用于前端（比如 index.html）初始化 Stripe.js。这个是公开的。
  STRIPE_PAYMENT_LINK_ID: string;        // 在 Stripe 后台创建的支付链接 (Payment Link) 的 ID。用来验证 Webhook 事件是否与我们期望的支付链接相关。
};

/**
 * 这是一个异步辅助函数，叫做 `streamToBuffer`。
 * 它的作用是把一个可读流 (ReadableStream) 转换成一个 Uint8Array (无符号 8 位整数数组，可以看作是原始的字节数据)。
 * 
 * 为什么需要这个函数？
 * Cloudflare Workers (以及现代 Web API) 处理 HTTP 请求体 (request body) 时，通常是以流的形式提供的。
 * 流的好处是可以处理非常大的数据，而不需要一次性把所有数据都加载到内存里，这样更高效，尤其是在网络传输时。
 * 但是，Stripe 的库在验证 Webhook 签名时，需要拿到完整的、未经修改的原始请求体数据 (raw body)。
 * 所以，我们需要先把这个流“读完”，把所有数据块 (chunks) 收集起来，拼接成一个完整的 Buffer (在这里是 Uint8Array)。
 * 
 * @param readableStream - 从请求体 (request.body) 获取的可读流。
 * @returns 一个 Promise，最终会解析为一个包含完整请求体数据的 Uint8Array。
 */
const streamToBuffer = async (
  readableStream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []; // 创建一个空数组，用来存放从流中读取的数据块。
  const reader = readableStream.getReader(); // 获取流的读取器 (reader)。

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) { // 无限循环，直到流被读完。
      // 读取下一个数据块。`reader.read()` 返回一个 Promise，包含 { done, value }。
      // `done` 是布尔值，表示流是否结束。
      // `value` 是实际的数据块 (Uint8Array)，如果流未结束的话。
      const { done, value } = await reader.read(); 
      if (done) { // 如果流结束了，就跳出循环。
        break;
      }
      chunks.push(value); // 把读取到的数据块添加到 chunks 数组中。
    }
  } finally {
    // `finally` 块确保无论读取过程中是否发生错误，都会执行这里的代码。
    reader.releaseLock(); // 释放读取器的锁。一个流同时只能有一个读取器在读取。
  }

  // 现在 chunks 数组包含了所有的数据块。我们需要把它们合并成一个单独的 Uint8Array。

  // 1. 计算所有数据块的总长度。
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);

  // 2. 创建一个新的 Uint8Array，长度为计算出的总长度。
  const result = new Uint8Array(totalLength);

  // 3. 遍历所有数据块，并将它们按顺序复制到新的 result 数组中。
  let position = 0; // 记录当前在 result 数组中写入的位置。
  for (const chunk of chunks) {
    result.set(chunk, position); // 将当前 chunk 的数据复制到 result 的指定 position。
    position += chunk.length; // 更新下一个写入位置。
  }

  return result; // 返回包含完整请求体数据的 Uint8Array。
};

/**
 * 这是 Cloudflare Worker 的入口函数。
 * 当 Worker 接收到一个 HTTP 请求时，会调用这个函数，并传入 `Request` 和 `Env` 对象。
 * 
 * @param request - HTTP 请求对象。
 * @param env - Worker 的环境变量对象。
 * @returns 一个 Promise，最终会解析为一个 HTTP 响应对象。
 */
export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url); // 解析请求的 URL。

    // 检查请求的路径是否是我们期望的 Stripe Webhook 路径。
    // 我们只处理发送到 `/stripe-webhook` 的请求，其他路径的请求直接返回 404 Not Found。
    // 这是为了确保 Worker 只响应 Stripe 的通知，而不是其他任意请求。
    if (url.pathname !== "/stripe-webhook") {
      console.log(`Received request for unexpected path: ${url.pathname}`);
      return new Response("Not a stripe webhook endpoint", { status: 404 });
    }

    // Stripe 的 Webhook 请求通常是 POST 请求，并且应该包含请求体。
    // 检查请求体是否存在。如果不存在，返回错误响应。
    if (!request.body) {
      console.warn("Webhook request received with no body.");
      return new Response(
        JSON.stringify({ isSuccessful: false, message: "No body included in webhook request." }), // 返回 JSON 格式的错误信息
        { headers: { "Content-Type": "application/json" }, status: 400 } // 设置响应头和状态码 400 Bad Request
      );
    }

    // 使用我们之前定义的 `streamToBuffer` 函数来读取完整的原始请求体。
    // `await` 表示等待这个异步操作完成。
    const rawBody = await streamToBuffer(request.body);
    // 为了能被 Stripe SDK 使用，以及方便调试打印，我们将 Uint8Array 转换为字符串。
    // 注意：Stripe SDK 内部在验证签名时，通常会使用原始的 Buffer/Uint8Array 或字符串形式。
    // TextDecoder 用于将字节流解码成字符串。
    const rawBodyString = new TextDecoder().decode(rawBody); // 这个字符串主要用于日志或需要字符串输入的地方

    // 调试日志，可以打印原始请求体的内容，但在生产环境中通常会注释掉。
    // console.log("Raw body (Uint8Array):", rawBody);
    // console.log("Raw body (String snippet):", rawBodyString.substring(0, 100) + "...");

    // 从环境 `env` 对象中获取 Stripe 相关的密钥和配置。
    const stripeWebhookSigningSecret = env.STRIPE_WEBHOOK_SIGNING_SECRET;
    const stripeSecret = env.STRIPE_SECRET;
    const stripePublishableKey = env.STRIPE_PUBLISHABLE_KEY; // 虽然这里获取了，但在后端 Webhook 处理中通常用不到可发布密钥。
    const paymentLinkId = env.STRIPE_PAYMENT_LINK_ID;

    // 检查所有必需的 Stripe 环境变量是否都已设置。
    // 如果有任何一个缺失，就无法安全地处理 Webhook，需要记录错误并返回 500 Internal Server Error。
    // 注意：根据你的具体逻辑，可能不是所有这些变量都是绝对必需的。例如，如果只处理一种支付，可能不需要检查 paymentLinkId。
    if (
      !stripeWebhookSigningSecret ||
      !stripeSecret ||
      // !stripePublishableKey || // 通常后端不需要可发布密钥
      !paymentLinkId // 这个 ID 是此示例特定逻辑需要的
    ) {
      console.error("CRITICAL: Missing one or more required Stripe environment variables for webhook processing!"); 
      // 打印哪些变量缺失，帮助调试，但不要打印密钥本身！
      console.log("Check environment variable status:", {
        hasWebhookSecret: !!stripeWebhookSigningSecret,
        hasSecretKey: !!stripeSecret,
        // hasPublishableKey: !!stripePublishableKey, 
        hasPaymentLink: !!paymentLinkId
      });
      // 返回 500 Internal Server Error，因为这是服务器配置问题，不是客户端请求的问题。
      return new Response(
        JSON.stringify({ isSuccessful: false, message: "Server configuration error: Missing critical Stripe credentials." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 使用 Stripe 私密密钥初始化 Stripe SDK 实例。
    // `apiVersion` 指定了我们希望使用的 Stripe API 的版本。强烈建议明确指定一个版本，
    // 这样可以确保你的代码不会因为 Stripe 未来更新 API 而意外中断。选择一个你测试过的稳定版本。
    const stripe = new Stripe(stripeSecret, {
      apiVersion: "2025-03-31.basil",
    });

    // 从请求头 (headers) 中获取 Stripe 发送过来的签名。
    // Stripe 在发送每个 Webhook 事件时，都会在 `Stripe-Signature` HTTP 头部包含一个签名。
    // 这个签名是基于你的 Webhook Signing Secret 和请求体内容计算出来的。
    const stripeSignature = request.headers.get("stripe-signature");

    // 检查签名是否存在于请求头中。
    // 如果没有这个头部，这个请求很可能不是来自 Stripe，或者中间代理可能把它移除了。
    // 必须拒绝处理没有签名的请求。
    if (!stripeSignature) {
      console.warn("Webhook received without 'Stripe-Signature' header. Rejecting.");
      return new Response(
        JSON.stringify({ isSuccessful: false, message: "Missing 'Stripe-Signature' header." }),
        { status: 400, headers: { "Content-Type": "application/json" } } // 返回 400 Bad Request
      );
    }
    
    // 定义一个变量来存储解析和验证后的 Stripe 事件对象。
    // 初始化为 undefined，在签名验证成功后会被赋值。
    let event: Stripe.Event | undefined = undefined;

    // 一个简单的调试开关。当设置为 `true` 时，会打印一些额外的日志信息，
    // 帮助追踪 Webhook 的接收和验证过程。在生产环境中应将其设置为 `false` 以减少日志量并避免泄露敏感信息。
    const isDebugInput = false; // TODO: Consider using environment variable for debug flags

    // 如果启用了调试模式，打印尝试验证签名的信息。
    // 注意：绝不在日志中打印完整的 rawBody 或 webhook secret！只打印签名头本身通常是安全的。
    if (isDebugInput) {
      console.log("Attempting to verify webhook signature with header:", stripeSignature);
      // 可以考虑打印 body 的摘要或长度，但避免打印完整内容。
      // console.log("Raw body length:", rawBody.byteLength); 
    }

    // *** 最关键的安全步骤：验证 Webhook 签名并解析事件 ***
    // 使用 Stripe SDK 提供的 `constructEventAsync` 方法（或同步版本 `constructEvent`，但在 Worker 中推荐异步）。
    // 这个方法会执行以下操作：
    // 1. 解析 `rawBody` (原始请求体)。
    // 2. 从 `stripeSignature` 头部提取时间戳和签名。
    // 3. 使用你提供的 `stripeWebhookSigningSecret` (Webhook 密钥)、提取的时间戳、原始请求体来重新计算预期签名。
    // 4. 比较计算出的签名和请求头中的签名是否一致。
    // 5. 检查时间戳是否在可接受的时间窗口内（防止重放攻击）。
    // 只有当所有这些检查都通过时，该方法才会成功返回解析后的 `Stripe.Event` 对象。
    // 如果任何检查失败（签名不匹配、时间戳过期、解析错误等），它会抛出一个错误。
    try {
      // **强烈推荐** 直接将原始的 `rawBody` (Uint8Array 或 Buffer 类型) 传递给 `constructEventAsync`。
      // 虽然它也能接受字符串，但使用原始字节流可以避免因编码问题导致的签名验证失败。
      event = await stripe.webhooks.constructEventAsync(
        rawBody, // 使用原始的 Uint8Array
        stripeSignature, // 从请求头获取的签名字符串
        stripeWebhookSigningSecret, // 你的 Webhook Signing Secret (从环境变量获取)
        undefined, // 可选：时间戳容差 (tolerance)，默认通常足够
        undefined, // 可选：自定义 cryptoProvider (Cloudflare Workers 通常不需要)
      );
      
      // 如果验证成功且开启了调试模式，打印成功信息和事件的基本信息。
      if (isDebugInput) {
        console.log(`✅ Webhook signature verified successfully. Event ID: ${event.id}, Type: ${event.type}`);
      }
    } catch (err: any) { // 捕获验证过程中抛出的任何错误
      // 如果 `constructEventAsync` 抛出错误，说明签名验证失败或事件解析出错。
      // 必须记录这个错误，并向上游（Stripe）返回一个非 2xx 的状态码（通常是 400 Bad Request）。
      // 这会告诉 Stripe Webhook 发送失败，Stripe 会根据其重试策略尝试重新发送该事件。
      console.error(`❌ Webhook signature verification failed: ${err.message}`);
      
      // 可以检查错误的类型 (`err.type`) 来提供更具体的错误信息，
      // Stripe 的错误对象通常包含这个字段。
      if (err.type === 'StripeSignatureVerificationError') {
         // 特别是签名验证错误，明确指出。
         return new Response(`Webhook Error: Signature verification failed. Check your webhook signing secret and endpoint configuration.`, { status: 400 });
      } else {
         // 其他类型的错误（例如解析错误）
         return new Response(`Webhook Error: Could not process webhook event. ${err.message}`, { status: 400 });
      }
      // 注意：不要在错误响应中包含过多内部细节，以免泄露信息。
    }

    // 如果代码执行到这里，说明签名验证成功，并且 `event` 变量现在包含了可信的 Stripe 事件对象。
    // 接下来就可以根据 `event.type` 来处理不同的事件了。

    if (event.type === "checkout.session.completed") {
      // 从 `event.data.object` 中提取实际的 Stripe 对象。
      // 对于 'checkout.session.completed' 事件，这个对象就是 Checkout Session 对象。
      // 我们使用类型断言 `as Stripe.Checkout.Session` 告诉 TypeScript 我们期望这里的对象类型，
      // 以便获得更好的类型检查和代码自动补全。
      const session = event.data.object as Stripe.Checkout.Session; 
      
      // 如果启用了调试模式，打印关于这个特定会话的一些关键信息。
      // 这有助于在开发或测试期间理解收到的数据。
      if (isDebugInput) {
        console.log("Processing 'checkout.session.completed' event with session details:", {
          sessionId: session.id, // Stripe 会话 ID，非常重要，用于追踪和关联
          paymentStatus: session.payment_status, // 支付状态 ('paid', 'unpaid', 'no_payment_required')
          mode: session.mode, // 会话模式 ('payment', 'subscription', 'setup')
          amountTotal: session.amount_total, // 总金额 (最小货币单位, 如分)
          currency: session.currency, // 货币代码 (如 'usd', 'eur')
          paymentLink: session.payment_link, // 关联的支付链接 ID (如果通过支付链接创建)
          customerEmail: session.customer_details?.email, // 顾客邮箱 (可能不存在，使用可选链 ?. )
          customerName: session.customer_details?.name,  // 顾客姓名 (可能不存在)
          // 可以添加更多你想调试的字段
        });
      }
      
      // --- 进行一系列检查，确保这个事件是我们期望处理的 ---
      
      // 从会话对象中解构出我们关心的字段，方便使用。
      const {
        payment_status, // 支付状态
        mode,           // 会话模式
        amount_total,   // 总金额
        payment_link,   // 支付链接 ID
        customer_details,// 顾客详情对象
        currency,       // 货币
        id: sessionId   // 把会话 ID 也解构出来，方便日志记录
      } = session;

      // 1. (可选但推荐) 检查 Payment Link ID 是否匹配
      // 如果你的 Worker 只应该处理来自特定支付链接的付款，进行此检查可以增加一层保障。
      // 它能防止处理来自你 Stripe 账户中其他支付链接或直接 API 创建的会话完成事件。
      if (payment_link !== env.STRIPE_PAYMENT_LINK_ID) {
        console.warn(`Webhook event for session ${sessionId} has unexpected payment link ID: '${payment_link}'. Expected: '${env.STRIPE_PAYMENT_LINK_ID}'. Ignoring.`);
        // 返回 200 OK 表示我们成功收到了事件，但由于不匹配，我们选择忽略它。
        // 这样 Stripe 就不会重试这个事件了。返回 4xx 可能导致 Stripe 重试。
        return new Response(JSON.stringify({ received: true, message: "Payment link ID mismatch, event ignored." }), { status: 200 });
      }

      // 2. 核心检查：确保支付状态是 "paid"
      // `checkout.session.completed` 事件并不总是意味着钱已到账。
      // 对于某些异步支付方式（如银行转账），会话可能先完成，但支付状态是 `unpaid`。
      // 只有当 `payment_status` 是 `paid` 时，才表示支付已确认成功。
      // 同时，检查 `amount_total` 是否有效（不为 null 或 undefined）。
      if (payment_status !== "paid" || amount_total === null || amount_total === undefined) {
        console.warn(`Checkout session ${sessionId} completed event received, but payment status is '${payment_status}' or amount_total is missing. Ignoring.`);
        // 同样返回 200 OK，因为事件本身是有效的，只是状态不满足我们的处理条件。
        return new Response(JSON.stringify({ received: true, message: "Payment not successfully confirmed ('paid') or amount missing." }), { status: 200 });
      }

      // 3. 检查顾客信息是否存在 (根据业务需求决定)
      // `customer_details` 可能为 null，或者里面的 `email` 可能为 null。
      // 例如，某些支付方式或配置下，Stripe 可能无法收集到邮箱。
      // 如果你的业务逻辑（如发送确认邮件、关联用户账户）强依赖于顾客邮箱，
      // 那么必须在这里检查并拒绝处理缺少邮箱的事件。
      if (!customer_details || !customer_details.email) { 
        console.warn(`Checkout session ${sessionId} completed without required customer details (email). Cannot process.`);
        // 在这种情况下，返回 400 Bad Request 可能更合适，因为它表示请求数据不完整，无法满足处理要求。
        // 这可能会让 Stripe 重试，但如果邮箱就是获取不到，重试也没用。
        // 也可以返回 200 并记录下来，稍后人工处理。选择取决于你的容错策略。
        return new Response(JSON.stringify({ received: true, message: "Customer details (email) missing, cannot process." }), { status: 400 }); // 或者 200
      }

      // 4. 检查会话模式 (Mode)
      // 这个 Worker 示例是设计用来处理一次性付款 (`payment` 模式) 的。
      // 如果它收到了订阅 (`subscription`) 或设置意图 (`setup`) 的完成事件，
      // 这通常表示配置错误或收到了非预期的事件。明确地忽略这些事件。
      if (mode === "subscription" || mode === "setup") {
        console.log(`Received completed session ${sessionId} for currently unsupported mode: ${mode}. Ignoring.`);
        // 返回 200 OK 表示收到了，但我们不处理这种模式。
        return new Response(JSON.stringify({ received: true, message: `Mode '${mode}' not supported by this webhook handler.` }), { status: 200 }); 
      }

      // 5. (可选业务逻辑) 检查最低支付金额
      // 你可能希望忽略非常小额的支付，或者对不同金额范围有不同处理逻辑。
      // 这里的金额是最小货币单位（例如美分）。50 表示 $0.50 USD 或 €0.50 EUR。
      const minimumAmount = 50; // 设置你的最低接受金额阈值
      if (amount_total < minimumAmount) { 
        console.log(`Payment amount ${amount_total} ${currency || ''} for session ${sessionId} is below threshold (${minimumAmount}). Ignoring.`);
        // 返回 400 Bad Request 表示不满足业务规则。
        // 或者返回 200 如果你只是想记录并忽略。
        return new Response(JSON.stringify({ received: true, message: `Paid amount (${amount_total} ${currency || ''}) is too small.` }), { status: 400 }); // 或 200
      }

      // --- 所有初步检查通过 ---
      // 如果代码执行到这里，说明这个 `checkout.session.completed` 事件满足了我们所有的基本验证条件：
      // - 来自正确的支付链接 (如果检查了)
      // - 支付状态是 'paid'
      // - 金额有效
      // - 包含必要的顾客邮箱
      // - 是一次性支付模式 ('payment')
      // - 满足最低金额要求 (如果检查了)
      // 现在可以安全地执行后续的业务逻辑了。

      // --- 支付成功，执行业务逻辑 ---
      // 到这里，我们非常确信收到了一个有效的、我们关心的、并且已经成功付款的事件。
      // 这是处理支付成功后执行你的应用程序特定逻辑的地方。

      // 提取顾客的关键信息。我们在之前的步骤中已经确保 `customer_details` 和 `customer_details.email` 存在。
      // `name` 可能仍然是 null，所以在使用时需要处理这种情况。
      const { email, name } = customer_details; 

      // 打印一条清晰的成功日志。在生产环境中，你可能希望使用更结构化的日志格式（例如 JSON），
      // 以便更好地进行监控和分析。包含关键信息如 Session ID、顾客邮箱、金额和货币。
      console.log(
        `✅ Payment SUCCESSFUL for session ${sessionId}. Customer: ${name || 'N/A'} <${email}> paid ${amount_total / 100} ${currency || ''}.` // 假设 amount_total 是分的单位，除以 100 得到元/美元等主单位。处理 currency 可能为 null 的情况。
      );

      // ********************************************************************************
      // ***                          核心业务逻辑区域                           ***
      // ********************************************************************************
      // 在这个区域，你需要根据你的具体业务需求，编写处理支付成功的代码。
      // 以下是一些常见的例子：
      //
      // 1. **授权访问或发放商品**:
      //    - **查找用户**: 使用 `email` 在你的用户数据库中查找对应的用户记录。
      //    - **更新状态**: 更新用户记录，标记他们为“已付费”或“订阅激活”。
      //    - **开通服务**: 如果是 SaaS 服务，调用相应的 API 或更新数据库来启用用户的付费功能。
      //    - **发送数字商品**: 如果是电子书、软件许可等，生成下载链接或激活码，并可能通过邮件发送给用户。
      //    - **库存管理**: 如果是实体商品（虽然 Worker 通常不直接处理物流），可能需要调用库存系统 API。
      //    - **使用 Cloudflare 服务**:
      //      - **KV 存储**: 简单场景下，可以将用户的付费状态存入 KV:
      //        `await env.YOUR_KV_NAMESPACE.put(email, JSON.stringify({ paid: true, sessionId: sessionId, amount: amount_total, timestamp: Date.now() }));`
      //      - **Durable Objects**: 对于需要更复杂状态管理或事务性操作的用户数据，Durable Objects 是更好的选择。
      //
      // 2. **发送确认通知**:
      //    - **邮件确认**: 使用邮件服务（如 SendGrid, Mailgun, AWS SES, 或 Cloudflare Email Workers）向 `email` 发送一封包含订单详情的购买确认邮件。
      //      `// await sendConfirmationEmail(email, name, amount_total, currency, sessionId);`
      //    - **应用内通知**: 如果有用户界面，可以发送一个应用内通知。
      //
      // 3. **记录交易信息**:
      //    - **内部数据库**: 在你自己的数据库中创建一个交易记录，保存 Stripe Session ID (`sessionId`)、顾客信息、金额、时间等，用于审计、对账和客服支持。
      //
      // --- ⚠️ 关于幂等性 (Idempotency) 的重要提示 ---
      // Webhook 处理逻辑必须是幂等的。这意味着即使 Stripe 由于网络问题或其他原因重复发送了同一个 `checkout.session.completed` 事件（使用相同的 `event.id`），
      // 多次执行你的业务逻辑也不会产生错误的副作用（例如，不会给用户重复开通服务、重复发送商品或重复记账）。
      // 实现幂等性的常用方法：
      // a. **检查 Event ID**: 在处理事件之前，检查你的数据库或 KV 存储中是否已经记录了这个 `event.id`。如果已记录，说明这个事件已经被处理过，直接返回 200 OK，不再执行业务逻辑。
      //    ```typescript
      //    // const eventId = event.id;
      //    // if (await hasProcessedEvent(env, eventId)) {
      //    //   console.log(`Event ${eventId} already processed. Skipping.`);
      //    //   return new Response(JSON.stringify({ received: true, message: "Event already processed." }), { status: 200 });
      //    // }
      //    // // 如果未处理，则执行业务逻辑...
      //    // await markEventAsProcessed(env, eventId); // 标记为已处理
      //    ```
      // b. **检查业务状态**: 检查业务逻辑执行的结果是否已经存在。例如，如果业务逻辑是创建一个订单记录，那么先检查是否已存在对应 `sessionId` 的订单。如果存在，则跳过创建。
      // 选择哪种方法取决于你的具体业务场景。通常检查 Event ID 是更通用的做法。
      // ********************************************************************************
      
      // --- 向上游 Stripe 返回成功响应 ---
      // 在成功处理（或至少开始处理）事件后，必须向 Stripe 返回一个 HTTP 2xx 状态码（通常是 200 OK）。
      // 这明确告知 Stripe：“我已经收到了这个事件，并且成功处理了（或者正在处理），请不要再重发了。”
      // 如果你不返回 2xx 响应（例如返回 4xx, 5xx 或超时），Stripe 会认为投递失败，并在一段时间内尝试重发该事件。
      // 响应体 (response body) 可以为空，或者包含一个简单的 JSON 消息，方便你在 Stripe Dashboard 查看 Webhook 日志时确认是你的 Worker 返回的响应。
      return new Response(JSON.stringify({ received: true, message: "Payment processed successfully by worker." }), {
        status: 200, // 关键是这个状态码！
        headers: { "Content-Type": "application/json" }, // 良好的实践是指定响应类型
      });

    } // 结束 if (event.type === "checkout.session.completed") 处理块

    // --- 处理其他类型的事件 (例如订阅事件) ---
    // 虽然这个示例主要关注一次性付款 (通过 checkout session)，但一个完整的 webhook 处理器
    // 可能还需要处理订阅生命周期事件。这里是一个处理订阅取消/暂停/删除事件的示例框架。
    if (
      event.type === "customer.subscription.deleted" || // 订阅被彻底删除
      event.type === "customer.subscription.updated" || // 订阅被更新 (状态可能变为 unpaid, canceled, paused 等)
      event.type === "customer.subscription.paused"    // 订阅进入暂停期 (例如，付款失败后宽限期结束)
    ) {
      // --- 提取订阅对象 ---
      // 从事件数据中获取订阅对象的详细信息。
      // 注意：我们使用了类型断言 `as Stripe.Subscription`。这要求你已经安装了 `@types/stripe`
      // 或者在你的 Env 接口或某个类型定义文件中定义了兼容的 Stripe.Subscription 类型。
      // 如果 TS 报错找不到 Stripe 类型，你需要安装类型定义：`npm install --save-dev @types/stripe` 或 `yarn add --dev @types/stripe`
      // 如果你没有安装类型，可以暂时用 `as any` 或更具体的结构类型 `{ id: string; status: string; customer: string | Stripe.Customer | null; ... }` 替代，但这会失去类型安全。
      const subscription = event.data.object as Stripe.Subscription; 

      // --- 判断是否需要处理为“移除”订阅 ---
      // 检查订阅的状态，确定是否需要执行清理或撤销访问权限的操作。
      // 'unpaid': 付款失败且宽限期已过（如果设置了的话）。
      // 'canceled': 订阅已被用户或管理员明确取消，或者自动取消（例如，未能成功续订）。
      // 注意：'paused' 状态也包含在此处，意味着暂停期间用户通常不应享有服务。
      // 你的业务逻辑可能需要根据具体状态 (unpaid, canceled, paused) 做稍微不同的处理。
      const shouldRemoveSubscription =
        subscription.status === "unpaid" || 
        subscription.status === "canceled" ||
        subscription.status === "paused"; // 将 paused 也视为需要处理的状态

      // --- 如果订阅仍然有效，则无需操作 ---
      // 如果订阅状态是 'active', 'trialing', 'incomplete', 'past_due' (仍在宽限期) 等，
      // 这个 webhook 可能只是通知性的（例如 'customer.subscription.updated' 可能只是更新了元数据），
      // 或者我们在这个特定的处理流程中不关心这些状态。
      // 直接返回 200 OK 告知 Stripe 我们收到了事件。
      if (!shouldRemoveSubscription) {
        console.log(`Subscription ${subscription.id} status (${subscription.status}) does not require removal action. Skipping.`);
        // 返回 200 OK，消息说明情况
        return new Response(JSON.stringify({ received: true, message: "Subscription update received, no removal action needed based on status." }), { status: 200 });
      }

      // --- 处理订阅终止/暂停的逻辑 ---
      // 到这里，说明订阅的状态是 unpaid, canceled, 或 paused。
      // 这是执行你的业务逻辑以反映订阅变化的地方。
      console.log(`Subscription ${subscription.id} for customer ${subscription.customer} requires removal/update due to status: ${subscription.status}.`);

      // **核心业务逻辑占位符**:
      // 1. **查找用户**: 使用 `subscription.customer` (这是 Stripe Customer ID) 在你的系统中查找关联的用户。
      //    你可能需要在创建 Checkout Session 时将你的内部用户 ID 存储在 Session 的 metadata 中，
      //    或者在 `checkout.session.completed` 时将 Stripe Customer ID 与你的用户关联起来。
      // 2. **更新用户状态**: 在你的数据库或 KV 中更新用户的订阅状态 (e.g., 'inactive', 'paused')。
      // 3. **撤销访问**: 禁用用户的付费功能或服务访问权限。
      // 4. **发送通知**: (可选) 向用户发送邮件，告知他们的订阅状态已改变。
      // 5. **记录日志**: 记录此事件以供审计。
      //
      // `// await handleSubscriptionTermination(env, subscription.customer, subscription.id, subscription.status);`

      // --- 同样需要考虑幂等性 ---
      // 与 checkout.session.completed 类似，处理订阅事件也必须是幂等的。
      // 使用 `event.id` 来防止重复处理同一个事件通知。
      // `// const eventId = event.id;`
      // `// if (await hasProcessedEvent(env, eventId)) {`
      // `//   console.log(`Event ${eventId} (subscription) already processed. Skipping.`);`
      // `//   return new Response(JSON.stringify({ received: true, message: "Subscription event already processed." }), { status: 200 });`
      // `// }`
      // `// await markEventAsProcessed(env, eventId);`

      // --- 向 Stripe 返回成功响应 ---
      // 告知 Stripe 我们已收到并处理了此订阅事件。
      return new Response(JSON.stringify({ received: true, message: `Subscription ${subscription.status} processed.` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } // <- 结束 subscription event 处理块

    // --- 处理所有其他未明确处理的事件 ---
    // 这个 `if` 块之前的代码处理了我们明确关心的事件类型 (`checkout.session.completed` 和一些订阅事件)。
    // 对于所有其他类型的 Stripe 事件 (例如 `payment_intent.succeeded`, `invoice.paid`, `customer.created` 等)，
    // 这个 Worker 当前的逻辑是不处理它们。

    // 如果开启了调试模式 (`isDebugInput = true`)，我们会打印一条日志，记录收到了哪个未处理的事件类型。
    // 这在开发和测试阶段很有用，可以了解 Stripe 发送了哪些我们可能需要处理的事件。
    if (isDebugInput) {
      console.log(`🟠 UNHANLDED EVENT TYPE: ${event.type}. Responding 200 OK.`);
    }

    // --- 对未处理事件返回 200 OK ---
    // **关键实践**: 即使你不处理某个事件类型，也应该向 Stripe 返回 HTTP 200 OK 响应。
    // 这表示：“我收到了你的通知，虽然我没对它做什么，但我确认收到了。”
    // 如果你返回 4xx 或 5xx 错误，或者请求超时，Stripe 会认为事件投递失败，并会尝试重发该事件，
    // 这会不必要地增加你的 Worker 负载，并在 Stripe Dashboard 中产生 webhook 错误日志。
    // 返回 200 OK 可以让 Stripe 停止重试。
    return new Response(JSON.stringify({ received: true, message: "Unhandled event type received and acknowledged." }), {
      status: 200, // 核心是这个状态码！
      headers: { "Content-Type": "application/json" }, // 保持响应格式一致
    });

  }, // <- 结束 fetch 异步箭头函数体

}; // <- 结束 export default 对象，这个对象定义了 Worker 的行为
