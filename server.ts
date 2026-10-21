import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import {
  PRINTING_AI_SYSTEM_PROMPT,
  safeParseAIAnalysisJson,
} from './src/utils/printingBrain';
import {
  FacebookWebhookEventItem,
  InteractionType,
  PageId,
  TechnicalSpec,
} from './src/types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '5mb' }));

// In-memory store for Facebook Graph API connected pages & recent webhook events
interface ConnectedFbPageServer {
  slotId: PageId;
  fbPageId: string;
  name: string;
  specialty: string;
  accessToken: string;
  webhookSubscribed: boolean;
}

const connectedPagesStore: Record<PageId, ConnectedFbPageServer> = {
  page1: {
    slotId: 'page1',
    fbPageId: '108823410001',
    name: 'In Ấn Nhanh',
    specialty: 'Chuyên Danh thiếp, Decal dán kính, Tem nhãn, Tờ rơi',
    accessToken: 'fb_page_token_slot_1',
    webhookSubscribed: true,
  },
  page2: {
    slotId: 'page2',
    fbPageId: '108823410002',
    name: 'Xưởng Bao Bì Giấy',
    specialty: 'Chuyên Hộp giấy Ivory/Kraft/Duplex, Túi giấy thương hiệu',
    accessToken: 'fb_page_token_slot_2',
    webhookSubscribed: true,
  },
  page3: {
    slotId: 'page3',
    fbPageId: '108823410003',
    name: 'Tổng Kho Thùng Carton',
    specialty: 'Chuyên Thùng carton 3-5 lớp, Hộp ship COD',
    accessToken: 'fb_page_token_slot_3',
    webhookSubscribed: true,
  },
};

const webhookEventsLog: FacebookWebhookEventItem[] = [];

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function analyzeWithGeminiOrFallback(params: {
  customerMessage: string;
  conversationHistory: { sender: string; content: string }[];
  currentSpecs: TechnicalSpec;
  interactionType: InteractionType;
  pageId: PageId;
  pageName: string;
}) {
  const {
    customerMessage,
    conversationHistory,
    currentSpecs,
    interactionType,
    pageId,
    pageName,
  } = params;

  const ai = getGeminiClient();
  if (!ai) {
    return {
      result: safeParseAIAnalysisJson(
        null,
        customerMessage,
        currentSpecs,
        interactionType,
        pageId
      ),
      source: 'fallback-engine',
    };
  }

  try {
    const historyText = Array.isArray(conversationHistory)
      ? conversationHistory
          .map(
            (m) =>
              `${m.sender === 'customer' ? 'Khách hàng' : 'Tiến Phát AI'}: ${m.content}`
          )
          .join('\n')
      : '';

    const prompt = `Fanpage đang trực: ${pageName} (Mã: ${pageId})
Loại tương tác: ${interactionType}
Thông số kỹ thuật đã biết trước đó: ${JSON.stringify(currentSpecs)}

Lịch sử trò chuyện:
${historyText}

Tin nhắn/Bình luận mới nhất của khách hàng:
"${customerMessage}"

Hãy phân tích tin nhắn khách hàng theo đúng QUY TẮC BỘ NÃO AI NGÀNH IN của TIẾN PHÁT AI và trả về JSON chuẩn.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        systemInstruction: PRINTING_AI_SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            replyMessage: { type: Type.STRING },
            status: { type: Type.STRING },
            shouldHideComment: { type: Type.BOOLEAN },
            specs: {
              type: Type.OBJECT,
              properties: {
                product: { type: Type.STRING },
                dimensions: { type: Type.STRING },
                quantity: { type: Type.STRING },
                materialAndFinishing: { type: Type.STRING },
                designFileStatus: { type: Type.STRING },
                phoneOrZalo: { type: Type.STRING },
                deliveryAddress: { type: Type.STRING },
              },
              required: [
                'product',
                'dimensions',
                'quantity',
                'materialAndFinishing',
                'designFileStatus',
                'phoneOrZalo',
                'deliveryAddress',
              ],
            },
          },
          required: ['replyMessage', 'status', 'shouldHideComment', 'specs'],
        },
      },
    });

    const parsed = safeParseAIAnalysisJson(
      response.text,
      customerMessage,
      currentSpecs,
      interactionType,
      pageId
    );
    return { result: parsed, source: 'gemini-3.8-flash' };
  } catch {
    return {
      result: safeParseAIAnalysisJson(
        null,
        customerMessage,
        currentSpecs,
        interactionType,
        pageId
      ),
      source: 'fallback-recovery',
    };
  }
}

// 1. Gemini AI Analyze Message Endpoint
app.post('/api/ai/analyze-message', async (req, res) => {
  const {
    customerMessage = '',
    conversationHistory = [],
    currentSpecs = {},
    interactionType = 'Tin nhắn (Inbox)',
    pageId = 'page2',
    pageName = 'Xưởng Bao Bì Giấy',
  } = req.body || {};

  const safeSpecs: TechnicalSpec = {
    product: currentSpecs?.product || 'Chưa xác định',
    dimensions: currentSpecs?.dimensions || 'Chưa xác định',
    quantity: currentSpecs?.quantity || 'Chưa xác định',
    materialAndFinishing: currentSpecs?.materialAndFinishing || 'Chưa xác định',
    designFileStatus: currentSpecs?.designFileStatus || 'Chưa xác định',
    phoneOrZalo: currentSpecs?.phoneOrZalo || 'Chưa có SĐT',
    deliveryAddress: currentSpecs?.deliveryAddress || 'Chưa xác định',
  };

  const output = await analyzeWithGeminiOrFallback({
    customerMessage: String(customerMessage),
    conversationHistory,
    currentSpecs: safeSpecs,
    interactionType: interactionType as InteractionType,
    pageId: pageId as PageId,
    pageName: String(pageName),
  });

  res.json(output);
});

// 2. Gemini AI Marketing Post Endpoint
app.post('/api/ai/generate-post', async (req, res) => {
  const {
    pageName = 'Xưởng Bao Bì Giấy',
    specialty = 'Chuyên Hộp giấy Ivory/Kraft/Duplex, Túi giấy thương hiệu',
    productFocus = 'Hộp giấy Ivory ép kim cao cấp',
    campaignGoal = 'Thu hút khách sỉ đặt in bao bì dịp cuối năm',
    tone = 'Chuyên nghiệp, cam kết giá gốc tận xưởng',
  } = req.body || {};

  const buildFallbackPost = () => ({
    headline: `[XƯỞNG IN TIẾN PHÁT] Sản Xuất ${productFocus} Giá Gốc Tận Xưởng - Thiết Kế Miễn Phí 100%`,
    content: `Bạn đang tìm xưởng in trực tiếp không qua trung gian cho dòng sản phẩm ${productFocus}?\n\nTại ${pageName} - Hệ thống In Ấn & Bao Bì Tiến Phát, chúng tôi vận hành dây chuyền in Offset & Flexo công suất lớn:\n- Chuẩn màu sắc thương hiệu 99%, sắc nét từng chi tiết.\n- Đầy đủ chất liệu: Giấy Ivory, Kraft, Duplex, Couche C300, Sóng Carton 3-5 lớp.\n- Gia công đồng bộ: Cán màng mờ/bóng, ép kim logo, thúc nổi, bế khuôn tự động.\n- Hỗ trợ dựng mẫu 3D & in test màu miễn phí trước khi sản xuất hàng loạt.\n\nĐặc biệt cho chiến dịch "${campaignGoal}": Ưu đãi chiết khấu ngay 12% cho đơn hàng đặt in trong tuần này!`,
    cta: `Để lại ngay [Kích thước + Số lượng] hoặc SĐT Zalo bên dưới, chuyên viên kỹ thuật Tiến Phát sẽ gửi bảng báo giá xưởng trong 3 phút!`,
    hashtags: [
      '#InAnTienPhat',
      '#XuongBaoBiGiay',
      '#InHopGiayGiaXuong',
      '#ThungCartonGiaSi',
      '#InTemNhanDecal',
    ],
  });

  try {
    const ai = getGeminiClient();
    if (!ai) {
      res.json({ post: buildFallbackPost(), source: 'fallback-engine' });
      return;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `Hãy viết 1 bài đăng bán hàng Facebook Fanpage chuẩn SEO và thu hút khách để lại SĐT/Quy cách cho:
- Fanpage: ${pageName} (${specialty})
- Sản phẩm trọng tâm: ${productFocus}
- Mục tiêu chiến dịch: ${campaignGoal}
- Phong cách viết: ${tone}

Trả về đúng định dạng JSON gồm headline, content, cta, hashtags.`,
      config: {
        systemInstruction:
          'Bạn là Giám đốc Marketing ngành In ấn & Sản xuất Bao bì tại Việt Nam. Bài viết rõ ràng, đánh trúng tâm lý chủ shop/doanh nghiệp cần tìm xưởng in trực tiếp giá gốc, chất lượng sắc nét, giao hàng đúng tiến độ.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            content: { type: Type.STRING },
            cta: { type: Type.STRING },
            hashtags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['headline', 'content', 'cta', 'hashtags'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json({
      post: {
        headline: parsed.headline || buildFallbackPost().headline,
        content: parsed.content || buildFallbackPost().content,
        cta: parsed.cta || buildFallbackPost().cta,
        hashtags: Array.isArray(parsed.hashtags)
          ? parsed.hashtags
          : buildFallbackPost().hashtags,
      },
      source: 'gemini-3.8-flash',
    });
  } catch {
    res.json({ post: buildFallbackPost(), source: 'fallback-recovery' });
  }
});

// 3. Facebook OAuth 2.0 URL Generator & Callback (Follows oauth-integration skill)
app.get('/api/facebook/oauth-url', (req, res) => {
  const appUrl =
    process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
      ? process.env.APP_URL.replace(/\/$/, '')
      : `${req.protocol}://${req.get('host')}`;

  const redirectUri = `${appUrl}/auth/facebook/callback`;
  const fbAppId = process.env.FACEBOOK_APP_ID || '';
  const isConfigured = Boolean(
    fbAppId && fbAppId !== 'YOUR_FACEBOOK_APP_ID'
  );

  const scopes = [
    'pages_show_list',
    'pages_messaging',
    'pages_read_engagement',
    'pages_manage_metadata',
    'pages_manage_engagement',
  ].join(',');

  const params = new URLSearchParams({
    client_id: isConfigured ? fbAppId : 'YOUR_FACEBOOK_APP_ID',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state: 'tienphat_fb_oauth_2026',
  });

  const authUrl = `https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`;

  res.json({
    url: authUrl,
    redirectUri,
    isConfigured,
    fbAppId: isConfigured ? fbAppId : '',
    scopes: scopes.split(','),
  });
});

const facebookCallbackHandler: express.RequestHandler = async (req, res) => {
  const { code } = req.query;
  const fbAppId = process.env.FACEBOOK_APP_ID;
  const fbAppSecret = process.env.FACEBOOK_APP_SECRET;
  const appUrl =
    process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
      ? process.env.APP_URL.replace(/\/$/, '')
      : `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${appUrl}/auth/facebook/callback`;

  let fetchedPages: { id: string; name: string; category?: string; access_token?: string }[] = [];

  if (
    code &&
    fbAppId &&
    fbAppId !== 'YOUR_FACEBOOK_APP_ID' &&
    fbAppSecret &&
    fbAppSecret !== 'YOUR_FACEBOOK_APP_SECRET'
  ) {
    try {
      const tokenUrl = `https://graph.facebook.com/v20.0/oauth/access_token?${new URLSearchParams({
        client_id: fbAppId,
        redirect_uri: redirectUri,
        client_secret: fbAppSecret,
        code: String(code),
      }).toString()}`;

      const tokenRes = await fetch(tokenUrl);
      const tokenData = (await tokenRes.json()) as { access_token?: string };

      if (tokenData.access_token) {
        const pagesRes = await fetch(
          `https://graph.facebook.com/v20.0/me/accounts?fields=id,name,category,access_token&limit=3&access_token=${encodeURIComponent(
            tokenData.access_token
          )}`
        );
        const pagesData = (await pagesRes.json()) as {
          data?: { id: string; name: string; category?: string; access_token?: string }[];
        };
        if (Array.isArray(pagesData.data)) {
          fetchedPages = pagesData.data.slice(0, 3);
        }
      }
    } catch (e) {
      console.error('Facebook Graph OAuth exchange error:', e);
    }
  }

  const payloadJson = JSON.stringify({
    type: 'OAUTH_AUTH_SUCCESS',
    provider: 'facebook',
    pages: fetchedPages,
  });

  res.send(`<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <title>Kết nối Facebook OAuth - TIẾN PHÁT AI</title>
  </head>
  <body style="font-family: sans-serif; padding: 24px; text-align: center;">
    <script>
      if (window.opener) {
        window.opener.postMessage(${payloadJson}, '*');
        window.close();
      } else {
        window.location.href = '/';
      }
    </script>
    <p>Đã xác thực Facebook OAuth thành công. Cửa sổ sẽ tự động đóng.</p>
  </body>
</html>`);
};

app.get(
  ['/auth/facebook/callback', '/auth/facebook/callback/'],
  facebookCallbackHandler
);

// Sync max 3 connected Fanpages from client OAuth / Facebook Login SDK
app.post('/api/facebook/connect-pages', (req, res) => {
  const { pages = [] } = req.body || {};
  if (!Array.isArray(pages)) {
    res.status(400).json({ error: 'Danh sách Fanpage không hợp lệ' });
    return;
  }

  // Strictly enforce maximum of 3 Fanpages
  const boundedPages = pages.slice(0, 3);
  const slotIds: PageId[] = ['page1', 'page2', 'page3'];

  boundedPages.forEach((p, idx) => {
    const slotId = (p.slotId as PageId) || slotIds[idx];
    if (slotId && connectedPagesStore[slotId]) {
      connectedPagesStore[slotId] = {
        slotId,
        fbPageId: String(p.fbPageId || connectedPagesStore[slotId].fbPageId),
        name: String(p.name || connectedPagesStore[slotId].name),
        specialty: String(p.specialty || connectedPagesStore[slotId].specialty),
        accessToken: String(p.accessToken || 'fb_oauth_connected_token'),
        webhookSubscribed: Boolean(p.webhookSubscribed ?? true),
      };
    }
  });

  res.json({
    connectedCount: boundedPages.length,
    maxAllowed: 3,
    pages: Object.values(connectedPagesStore),
  });
});

// 4. Facebook Graph API Webhook Verification (GET) & Automated Gemini AI Handler (POST)
app.get(['/api/webhooks/facebook', '/api/webhooks/facebook/'], (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedVerifyToken =
    process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'tienphat_ai_webhook_2026';

  if (mode === 'subscribe' && token === expectedVerifyToken) {
    res.status(200).send(String(challenge || 'WEBHOOK_VERIFIED'));
    return;
  }

  res.status(403).json({
    error: 'Webhook verification failed. Invalid hub.verify_token.',
  });
});

app.post(
  ['/api/webhooks/facebook', '/api/webhooks/facebook/'],
  async (req, res) => {
    const body = req.body;

    if (!body || body.object !== 'page' || !Array.isArray(body.entry)) {
      res.status(400).json({ error: 'Payload không phải chuẩn object=page của Facebook Graph API' });
      return;
    }

    const processedEvents: FacebookWebhookEventItem[] = [];

    for (const entry of body.entry) {
      const fbPageId = String(entry.id || '108823410002');
      const matchedPage =
        Object.values(connectedPagesStore).find((p) => p.fbPageId === fbPageId) ||
        connectedPagesStore.page2;

      // A. Handle Messenger Inbox Events (entry.messaging)
      if (Array.isArray(entry.messaging)) {
        for (const msgEvent of entry.messaging) {
          const text = msgEvent?.message?.text;
          if (!text) continue;

          const senderId = String(msgEvent?.sender?.id || 'psid_user');
          const senderName = String(
            msgEvent?.sender?.name || `Khách Messenger (${senderId.slice(-4)})`
          );

          const initialSpecs: TechnicalSpec = {
            product: 'Chưa xác định',
            dimensions: 'Chưa xác định',
            quantity: 'Chưa xác định',
            materialAndFinishing: 'Chưa xác định',
            designFileStatus: 'Chưa xác định',
            phoneOrZalo: 'Chưa có SĐT',
            deliveryAddress: 'Chưa xác định',
          };

          const { result: aiAnalysis } = await analyzeWithGeminiOrFallback({
            customerMessage: String(text),
            conversationHistory: [{ sender: 'customer', content: String(text) }],
            currentSpecs: initialSpecs,
            interactionType: 'Tin nhắn (Inbox)',
            pageId: matchedPage.slotId,
            pageName: matchedPage.name,
          });

          // If real Facebook Page Access Token is configured, send reply via Graph API
          let graphApiStatus = 'Đã phản hồi tự động qua Graph API /me/messages';
          if (
            matchedPage.accessToken &&
            !matchedPage.accessToken.startsWith('fb_')
          ) {
            try {
              await fetch(
                `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(
                  matchedPage.accessToken
                )}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    recipient: { id: senderId },
                    message: { text: aiAnalysis.replyMessage },
                  }),
                }
              );
            } catch {
              graphApiStatus = 'Đã tạo phản hồi AI (Chờ gửi Graph API)';
            }
          }

          const now = new Date();
          const timeText = `${String(now.getHours()).padStart(2, '0')}:${String(
            now.getMinutes()
          ).padStart(2, '0')}`;

          const eventRecord: FacebookWebhookEventItem = {
            id: `wh-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            receivedAt: timeText,
            fbPageId,
            mappedSlotId: matchedPage.slotId,
            mappedPageName: matchedPage.name,
            senderId,
            senderName,
            interactionType: 'Tin nhắn (Inbox)',
            incomingText: String(text),
            aiReply: aiAnalysis.replyMessage,
            status: aiAnalysis.status,
            shouldHideComment: aiAnalysis.shouldHideComment,
            specs: aiAnalysis.specs,
            graphApiStatus,
          };

          webhookEventsLog.unshift(eventRecord);
          processedEvents.push(eventRecord);
        }
      }

      // B. Handle Fanpage Feed Comment Events (entry.changes)
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          const val = change?.value;
          if (change?.field !== 'feed' || !val?.message) continue;

          const commentId = String(val.comment_id || 'comment_1');
          const senderId = String(val?.from?.id || 'fb_user');
          const senderName = String(
            val?.from?.name || `Khách Bình Luận (${senderId.slice(-4)})`
          );
          const text = String(val.message);

          const initialSpecs: TechnicalSpec = {
            product: 'Chưa xác định',
            dimensions: 'Chưa xác định',
            quantity: 'Chưa xác định',
            materialAndFinishing: 'Chưa xác định',
            designFileStatus: 'Chưa xác định',
            phoneOrZalo: 'Chưa có SĐT',
            deliveryAddress: 'Chưa xác định',
          };

          const { result: aiAnalysis } = await analyzeWithGeminiOrFallback({
            customerMessage: text,
            conversationHistory: [{ sender: 'customer', content: text }],
            currentSpecs: initialSpecs,
            interactionType: 'Bình luận (Comment)',
            pageId: matchedPage.slotId,
            pageName: matchedPage.name,
          });

          let graphApiStatus = aiAnalysis.shouldHideComment
            ? `Đã trả lời Comment & Gọi Graph API ẩn bình luận (${commentId}) chống cướp khách`
            : `Đã trả lời Comment tự động qua Graph API /${commentId}/comments`;

          if (
            matchedPage.accessToken &&
            !matchedPage.accessToken.startsWith('fb_')
          ) {
            try {
              if (aiAnalysis.shouldHideComment) {
                await fetch(
                  `https://graph.facebook.com/v20.0/${encodeURIComponent(
                    commentId
                  )}?access_token=${encodeURIComponent(matchedPage.accessToken)}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ is_hidden: true }),
                  }
                );
              }
              await fetch(
                `https://graph.facebook.com/v20.0/${encodeURIComponent(
                  commentId
                )}/comments?access_token=${encodeURIComponent(
                  matchedPage.accessToken
                )}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message: aiAnalysis.replyMessage }),
                }
              );
            } catch {
              graphApiStatus = 'Đã tạo phản hồi Comment AI';
            }
          }

          const now = new Date();
          const timeText = `${String(now.getHours()).padStart(2, '0')}:${String(
            now.getMinutes()
          ).padStart(2, '0')}`;

          const eventRecord: FacebookWebhookEventItem = {
            id: `wh-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            receivedAt: timeText,
            fbPageId,
            mappedSlotId: matchedPage.slotId,
            mappedPageName: matchedPage.name,
            senderId,
            senderName,
            interactionType: 'Bình luận (Comment)',
            incomingText: text,
            aiReply: aiAnalysis.replyMessage,
            status: aiAnalysis.status,
            shouldHideComment: aiAnalysis.shouldHideComment,
            specs: aiAnalysis.specs,
            graphApiStatus,
          };

          webhookEventsLog.unshift(eventRecord);
          processedEvents.push(eventRecord);
        }
      }
    }

    res.status(200).json({
      status: 'EVENT_RECEIVED',
      processedCount: processedEvents.length,
      events: processedEvents,
    });
  }
);

app.get('/api/webhooks/facebook/events', (_req, res) => {
  const verifyToken =
    process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'tienphat_ai_webhook_2026';
  res.json({
    verifyToken,
    connectedPages: Object.values(connectedPagesStore),
    events: webhookEventsLog.slice(0, 25),
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TIẾN PHÁT AI Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
