import type { ConnectedPage, PostQueue, ProductItem } from '@prisma/client';
import { prisma } from './db.ts';
import { decryptToken } from './crypto.ts';
import { publishToFacebookPage } from './facebook.ts';
import { generateOrganicFacebookCaption } from './ai.ts';

/**
 * Selects the next product for a ConnectedPage (rotating least-recently-used first)
 * and uses Gemini AI to generate a fresh, organic trust-building Facebook caption
 * from the product's image and details.
 */
export async function generateAutomatedPost(
  page: ConnectedPage,
  preferredProductId?: string
): Promise<{
  content: string;
  imageUrl?: string | null;
  productItemId?: string | null;
}> {
  let product: ProductItem | null = null;

  if (preferredProductId) {
    product = await prisma.productItem.findFirst({
      where: { id: preferredProductId, connectedPageId: page.id },
    });
  }

  if (!product) {
    product = await prisma.productItem.findFirst({
      where: { connectedPageId: page.id },
      orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  const caption = await generateOrganicFacebookCaption({
    pageName: page.pageName,
    pageCategory: page.pageCategory,
    productTitle: product?.title ?? null,
    productDetails: product?.details ?? null,
    imageUrl: product?.imageUrl ?? null,
  });

  return {
    content: caption,
    imageUrl: product?.imageUrl ?? null,
    productItemId: product?.id ?? null,
  };
}

export interface PublishAttemptResult {
  pageId: string;
  pageName: string;
  queueItemId: string;
  status: 'PUBLISHED' | 'FAILED';
  facebookPostId?: string;
  errorMessage?: string;
}

/**
 * Publishes an immediate test post for a specific ConnectedPage.
 * If no custom content is provided, Gemini AI generates the caption from the Page's
 * product catalog (image + product details).
 */
export async function publishTestPostForPage(
  page: ConnectedPage,
  customContent?: string,
  customImageUrl?: string | null,
  preferredProductId?: string
): Promise<PublishAttemptResult> {
  let message = customContent?.trim() || '';
  let imageUrl = customImageUrl?.trim() || null;
  let productItemId: string | null = preferredProductId || null;

  if (!message) {
    const generated = await generateAutomatedPost(page, preferredProductId);
    message = generated.content;
    imageUrl = imageUrl ?? generated.imageUrl ?? null;
    productItemId = generated.productItemId ?? null;
  }

  const queueEntry = await prisma.postQueue.create({
    data: {
      connectedPageId: page.id,
      productItemId,
      content: message,
      imageUrl,
      status: 'PENDING',
      scheduledFor: new Date(),
    },
  });

  return executePostPublish(page, queueEntry);
}

async function executePostPublish(
  page: ConnectedPage,
  queueItem: PostQueue
): Promise<PublishAttemptResult> {
  try {
    const pageAccessToken = decryptToken(page.encryptedAccessToken);
    const { facebookPostId } = await publishToFacebookPage({
      pageId: page.pageId,
      pageAccessToken,
      message: queueItem.content,
      imageUrl: queueItem.imageUrl,
    });

    const now = new Date();
    const txOperations = [
      prisma.postQueue.update({
        where: { id: queueItem.id },
        data: {
          status: 'PUBLISHED',
          facebookPostId,
          errorMessage: null,
          publishedAt: now,
        },
      }),
      prisma.connectedPage.update({
        where: { id: page.id },
        data: { lastPostedAt: now },
      }),
    ];

    if (queueItem.productItemId) {
      await prisma.$transaction([
        ...txOperations,
        prisma.productItem.updateMany({
          where: { id: queueItem.productItemId },
          data: { lastUsedAt: now },
        }),
      ]);
    } else {
      await prisma.$transaction(txOperations);
    }

    return {
      pageId: page.pageId,
      pageName: page.pageName,
      queueItemId: queueItem.id,
      status: 'PUBLISHED',
      facebookPostId,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown Graph API publishing error';
    await prisma.postQueue.update({
      where: { id: queueItem.id },
      data: {
        status: 'FAILED',
        errorMessage,
      },
    });

    return {
      pageId: page.pageId,
      pageName: page.pageName,
      queueItemId: queueItem.id,
      status: 'FAILED',
      errorMessage,
    };
  }
}

/**
 * Automated scheduler runner: finds all active ConnectedPages whose lastPostedAt is null
 * or older than their configured postFrequencyHours, pulls any queued PENDING post or
 * generates an AI post from the Page's ProductItems via Gemini, and publishes to Facebook.
 */
export async function runScheduledPublishing(): Promise<{
  checkedPages: number;
  duePages: number;
  results: PublishAttemptResult[];
}> {
  const now = new Date();
  const activePages = await prisma.connectedPage.findMany({
    where: { isActive: true },
  });

  const duePages = activePages.filter((page) => {
    if (!page.lastPostedAt) {
      return true;
    }
    const elapsedMs = now.getTime() - page.lastPostedAt.getTime();
    const intervalMs = page.postFrequencyHours * 60 * 60 * 1000;
    return elapsedMs >= intervalMs;
  });

  const results: PublishAttemptResult[] = [];

  for (const page of duePages) {
    let nextQueueItem = await prisma.postQueue.findFirst({
      where: {
        connectedPageId: page.id,
        status: 'PENDING',
        scheduledFor: { lte: now },
      },
      orderBy: { scheduledFor: 'asc' },
    });

    if (!nextQueueItem) {
      try {
        const generated = await generateAutomatedPost(page);
        nextQueueItem = await prisma.postQueue.create({
          data: {
            connectedPageId: page.id,
            productItemId: generated.productItemId ?? null,
            content: generated.content,
            imageUrl: generated.imageUrl ?? null,
            status: 'PENDING',
            scheduledFor: now,
          },
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'AI caption generation failed.';
        const failedRecord = await prisma.postQueue.create({
          data: {
            connectedPageId: page.id,
            content: '[AI caption generation failed before publish]',
            status: 'FAILED',
            errorMessage,
            scheduledFor: now,
          },
        });
        results.push({
          pageId: page.pageId,
          pageName: page.pageName,
          queueItemId: failedRecord.id,
          status: 'FAILED',
          errorMessage,
        });
        continue;
      }
    }

    const result = await executePostPublish(page, nextQueueItem);
    results.push(result);
  }

  return {
    checkedPages: activePages.length,
    duePages: duePages.length,
    results,
  };
}
