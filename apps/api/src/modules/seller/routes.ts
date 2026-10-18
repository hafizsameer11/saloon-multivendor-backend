import { Router } from 'express';
import { requireAuth, requireRole } from '../../middleware/auth';
import { applicationRouter } from './application';
import { sellerCatalogRouter } from './catalog';
import { sellerOpsRouter } from './operations';
import { sellerWindowsRouter } from './windows';

/** Everything under /api/v1/seller — only for seller accounts, always scoped to the caller's own salon. */
export const sellerRouter = Router();
sellerRouter.use(requireAuth, requireRole('seller'));
sellerRouter.use(applicationRouter);
sellerRouter.use(sellerCatalogRouter);
sellerRouter.use(sellerOpsRouter);
sellerRouter.use(sellerWindowsRouter);
