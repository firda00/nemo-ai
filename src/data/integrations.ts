// Integrations catalog — a broad, region-aware directory. A handful are live
// (real connect flow); the rest are "soon" cards so the catalog reflects the
// full roadmap across UZ / RU / US / EU / MENA / Africa / Global.

export type IntCategory =
  | 'messenger'
  | 'crm'
  | 'telephony'
  | 'marketplace'
  | 'payment'
  | 'calendar'
  | 'helpdesk'
  | 'ecommerce'
  | 'social'
  | 'tools'

export type IntRegion = 'uz' | 'ru' | 'us' | 'eu' | 'mena' | 'africa' | 'global'

export interface CatalogItem {
  id: string
  name: string
  category: IntCategory
  regions: IntRegion[]
  status: 'live' | 'soon'
}

export const INT_CATEGORIES: IntCategory[] = [
  'messenger', 'crm', 'telephony', 'marketplace', 'payment', 'calendar', 'helpdesk', 'ecommerce', 'social', 'tools',
]
export const INT_REGIONS: IntRegion[] = ['uz', 'ru', 'us', 'eu', 'mena', 'africa', 'global']

export const INTEGRATIONS: CatalogItem[] = [
  // messengers
  { id: 'telegram', name: 'Telegram', category: 'messenger', regions: ['uz', 'ru', 'global'], status: 'live' },
  { id: 'whatsapp', name: 'WhatsApp', category: 'messenger', regions: ['global'], status: 'live' },
  { id: 'instagram', name: 'Instagram', category: 'messenger', regions: ['global'], status: 'live' },
  { id: 'widget', name: 'Website widget', category: 'messenger', regions: ['global'], status: 'live' },
  { id: 'messenger', name: 'Facebook Messenger', category: 'messenger', regions: ['global'], status: 'soon' },
  { id: 'viber', name: 'Viber', category: 'messenger', regions: ['ru', 'uz', 'eu'], status: 'soon' },
  { id: 'wechat', name: 'WeChat', category: 'messenger', regions: ['global'], status: 'soon' },
  { id: 'line', name: 'LINE', category: 'messenger', regions: ['global'], status: 'soon' },
  { id: 'signal', name: 'Signal', category: 'messenger', regions: ['global'], status: 'soon' },

  // CRM
  { id: 'amocrm', name: 'amoCRM', category: 'crm', regions: ['ru', 'uz'], status: 'live' },
  { id: 'bitrix24', name: 'Bitrix24', category: 'crm', regions: ['ru', 'uz'], status: 'live' },
  { id: 'hubspot', name: 'HubSpot', category: 'crm', regions: ['us', 'global'], status: 'soon' },
  { id: 'salesforce', name: 'Salesforce', category: 'crm', regions: ['us', 'global'], status: 'soon' },
  { id: 'zoho', name: 'Zoho CRM', category: 'crm', regions: ['global'], status: 'soon' },
  { id: 'pipedrive', name: 'Pipedrive', category: 'crm', regions: ['eu', 'global'], status: 'soon' },
  { id: 'megaplan', name: 'Megaplan', category: 'crm', regions: ['ru'], status: 'soon' },
  { id: 'moysklad', name: 'MoySklad', category: 'crm', regions: ['ru'], status: 'soon' },

  // telephony
  { id: 'twilio', name: 'Twilio', category: 'telephony', regions: ['us', 'global'], status: 'soon' },
  { id: 'sipuni', name: 'Sipuni', category: 'telephony', regions: ['ru'], status: 'soon' },
  { id: 'onlinepbx', name: 'OnlinePBX', category: 'telephony', regions: ['ru'], status: 'soon' },
  { id: 'beeline', name: 'Beeline', category: 'telephony', regions: ['uz', 'ru'], status: 'soon' },
  { id: 'uztelecom', name: 'Uztelecom', category: 'telephony', regions: ['uz'], status: 'soon' },

  // marketplaces
  { id: 'uzum', name: 'Uzum Market', category: 'marketplace', regions: ['uz'], status: 'soon' },
  { id: 'wildberries', name: 'Wildberries', category: 'marketplace', regions: ['ru'], status: 'soon' },
  { id: 'ozon', name: 'Ozon', category: 'marketplace', regions: ['ru'], status: 'soon' },
  { id: 'yandexmarket', name: 'Yandex Market', category: 'marketplace', regions: ['ru'], status: 'soon' },
  { id: 'amazon', name: 'Amazon', category: 'marketplace', regions: ['us', 'global'], status: 'soon' },
  { id: 'etsy', name: 'Etsy', category: 'marketplace', regions: ['us', 'global'], status: 'soon' },

  // payments
  { id: 'payme', name: 'Payme', category: 'payment', regions: ['uz'], status: 'soon' },
  { id: 'click', name: 'Click', category: 'payment', regions: ['uz'], status: 'soon' },
  { id: 'uzcard', name: 'Uzcard', category: 'payment', regions: ['uz'], status: 'soon' },
  { id: 'humo', name: 'Humo', category: 'payment', regions: ['uz'], status: 'soon' },
  { id: 'stripe', name: 'Stripe', category: 'payment', regions: ['us', 'eu', 'global'], status: 'soon' },
  { id: 'paypal', name: 'PayPal', category: 'payment', regions: ['global'], status: 'soon' },
  { id: 'yookassa', name: 'YooKassa', category: 'payment', regions: ['ru'], status: 'soon' },
  { id: 'sberpay', name: 'SberPay', category: 'payment', regions: ['ru'], status: 'soon' },
  { id: 'mpesa', name: 'M-Pesa', category: 'payment', regions: ['africa'], status: 'soon' },
  { id: 'paystack', name: 'Paystack', category: 'payment', regions: ['africa'], status: 'soon' },
  { id: 'flutterwave', name: 'Flutterwave', category: 'payment', regions: ['africa'], status: 'soon' },
  { id: 'paytabs', name: 'PayTabs', category: 'payment', regions: ['mena'], status: 'soon' },
  { id: 'fawry', name: 'Fawry', category: 'payment', regions: ['mena'], status: 'soon' },
  { id: 'stcpay', name: 'STC Pay', category: 'payment', regions: ['mena'], status: 'soon' },

  // calendars
  { id: 'google', name: 'Google Calendar', category: 'calendar', regions: ['global'], status: 'live' },
  { id: 'outlook', name: 'Outlook Calendar', category: 'calendar', regions: ['global'], status: 'soon' },
  { id: 'calendly', name: 'Calendly', category: 'calendar', regions: ['global'], status: 'soon' },

  // helpdesk
  { id: 'zendesk', name: 'Zendesk', category: 'helpdesk', regions: ['us', 'global'], status: 'soon' },
  { id: 'intercom', name: 'Intercom', category: 'helpdesk', regions: ['us', 'global'], status: 'soon' },
  { id: 'freshdesk', name: 'Freshdesk', category: 'helpdesk', regions: ['global'], status: 'soon' },
  { id: 'usedesk', name: 'UseDesk', category: 'helpdesk', regions: ['ru'], status: 'soon' },

  // e-commerce
  { id: 'shopify', name: 'Shopify', category: 'ecommerce', regions: ['us', 'global'], status: 'soon' },
  { id: 'woocommerce', name: 'WooCommerce', category: 'ecommerce', regions: ['global'], status: 'soon' },
  { id: 'tilda', name: 'Tilda', category: 'ecommerce', regions: ['ru'], status: 'soon' },
  { id: 'insales', name: 'InSales', category: 'ecommerce', regions: ['ru'], status: 'soon' },

  // social
  { id: 'vk', name: 'VK', category: 'social', regions: ['ru'], status: 'soon' },
  { id: 'odnoklassniki', name: 'Odnoklassniki', category: 'social', regions: ['ru'], status: 'soon' },
  { id: 'tiktok', name: 'TikTok', category: 'social', regions: ['global'], status: 'soon' },
  { id: 'facebook', name: 'Facebook', category: 'social', regions: ['global'], status: 'soon' },
  { id: 'linkedin', name: 'LinkedIn', category: 'social', regions: ['us', 'global'], status: 'soon' },

  // tools & foundations (open-source building blocks we can self-host + offer)
  { id: 'opencode', name: 'OpenCode', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'openclaw', name: 'OpenClaw', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'twenty', name: 'Twenty CRM', category: 'crm', regions: ['global'], status: 'soon' },
  { id: 'keycloak', name: 'Keycloak (SSO)', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'sentry', name: 'Sentry', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'plausible', name: 'Plausible Analytics', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'plane', name: 'Plane', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'inboxzero', name: 'Inbox Zero', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'docmost', name: 'Docmost', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'growthbook', name: 'GrowthBook', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'formbricks', name: 'Formbricks', category: 'tools', regions: ['global'], status: 'soon' },
  { id: 'tonpay', name: 'TON Pay', category: 'payment', regions: ['global'], status: 'soon' },
]
