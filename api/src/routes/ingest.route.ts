import { Router } from 'express';
import { IngestController } from '../controllers/ingest.controller';

const router = Router();
const controller = new IngestController();

router.post('/ingest', controller.ingest);

export default router;
