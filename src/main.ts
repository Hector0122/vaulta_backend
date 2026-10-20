import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.use(json({ limit: '50mb' }));
  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: false,
  });
  const server = await app.listen(process.env.PORT ?? 3000);
  // Uploads now wait for processing; Node's 5-min default cuts big videos.
  server.requestTimeout = 10 * 60 * 1000;
}
void bootstrap();
