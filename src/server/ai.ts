import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured in environment secrets. Please set GEMINI_API_KEY to enable AI caption generation.'
    );
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

function guessMimeType(filePathOrUrl: string, contentTypeHeader?: string | null): string {
  if (contentTypeHeader && contentTypeHeader.startsWith('image/')) {
    return contentTypeHeader.split(';')[0].trim();
  }
  const lower = filePathOrUrl.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

async function resolveImageInlinePart(
  imageUrl?: string | null
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  if (!imageUrl || !imageUrl.trim()) {
    return null;
  }

  const trimmed = imageUrl.trim();

  // Local uploaded image stored in /uploads
  if (trimmed.startsWith('/api/uploads/')) {
    const filename = path.basename(trimmed);
    if (!filename || filename.includes('..')) {
      return null;
    }
    try {
      const fileBuffer = await fs.readFile(path.join(UPLOADS_DIR, filename));
      return {
        inlineData: {
          mimeType: guessMimeType(filename),
          data: fileBuffer.toString('base64'),
        },
      };
    } catch {
      return null;
    }
  }

  // Remote image URL
  if (/^https?:\/\/.+/i.test(trimmed)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(trimmed, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        return null;
      }

      const contentType = res.headers.get('content-type');
      if (contentType && !contentType.startsWith('image/')) {
        return null;
      }

      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > 10 * 1024 * 1024) {
        return null;
      }

      return {
        inlineData: {
          mimeType: guessMimeType(trimmed, contentType),
          data: Buffer.from(arrayBuffer).toString('base64'),
        },
      };
    } catch {
      return null;
    }
  }

  return null;
}

export async function generateOrganicFacebookCaption(params: {
  pageName: string;
  pageCategory?: string | null;
  productTitle?: string | null;
  productDetails?: string | null;
  imageUrl?: string | null;
}): Promise<string> {
  const ai = getGeminiClient();

  const { pageName, pageCategory, productTitle, productDetails, imageUrl } = params;
  const imagePart = await resolveImageInlinePart(imageUrl);

  const productContext = productDetails?.trim()
    ? [
        productTitle?.trim() ? `Product Name: ${productTitle.trim()}` : null,
        `Product Details: ${productDetails.trim()}`,
      ]
        .filter(Boolean)
        .join('\n')
    : `No specific product item was attached; write a helpful, organic trust-building brand update for the Facebook Page "${pageName}".`;

  const promptText = [
    `Facebook Page Name: ${pageName}`,
    pageCategory ? `Page Category: ${pageCategory}` : null,
    productContext,
    imagePart
      ? 'A product photo is attached. Reference visual details naturally from the photo alongside the product details.'
      : null,
    'Write one ready-to-publish Facebook Page caption (80–160 words) that builds organic trust with customers.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const systemInstruction =
    'You write authentic, human-sounding Facebook Page posts for businesses that want to stay consistent and build organic trust around their products. ' +
    'Lead with a relatable hook or practical benefit, highlight real details from the product info (and photo if attached), keep the tone warm and trustworthy (never pushy, spammy, or full of hype), ' +
    'include a gentle conversational question or soft call-to-action at the end, and add 2 to 4 relevant hashtags. ' +
    'Output ONLY the final Facebook caption text with no quotation marks, markdown headers, or explanations.';

  const contents = imagePart
    ? { parts: [imagePart, { text: promptText }] }
    : promptText;

  const response = await ai.models.generateContent({
    model: 'gemini-4-hydrogen',
    contents,
    config: {
      systemInstruction,
    },
  });

  const caption = response.text?.trim();
  if (!caption) {
    throw new Error('Gemini returned an empty caption.');
  }

  return caption;
}
