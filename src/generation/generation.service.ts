import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { Request, Response } from 'express';
import { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { GenerateDto } from './dto/generate.dto';

interface SsePayload {
  [key: string]: string;
}

type OpenAiStream = AsyncIterable<ResponseStreamEvent> & {
  controller?: AbortController;
};

@Injectable()
export class GenerationService {
  private openaiClient?: OpenAI;

  constructor(private readonly configService: ConfigService) {}

  async streamGeneration(
    generateDto: GenerateDto,
    request: Request,
    response: Response,
  ): Promise<void> {
    const settings = this.getOpenAiSettings();

    if (!settings) {
      response.status(500).json({
        message: 'No fue posible iniciar la generacion.',
      });
      return;
    }

    const openAiAbortController = new AbortController();

    let clientDisconnected = false;
    let completedNormally = false;
    let generationStarted = false;
    let openAiStream: OpenAiStream | undefined;

    const abortOpenAiStream = (): void => {
      if (completedNormally || clientDisconnected) {
        return;
      }

      clientDisconnected = true;

      if (!openAiAbortController.signal.aborted) {
        openAiAbortController.abort();
      }

      openAiStream?.controller?.abort();
      console.info('Generation stream aborted after client disconnect.');
    };

    const handleConnectionClosed = (): void => {
      if (!completedNormally && !response.writableEnded) {
        abortOpenAiStream();
      }
    };

    request.on('aborted', abortOpenAiStream);
    request.on('close', handleConnectionClosed);
    response.on('close', handleConnectionClosed);

    this.prepareSseResponse(response);
    this.writeSse(response, 'status', { status: 'waiting' });

    try {
      openAiStream = (await this.getClient(settings.apiKey).responses.create(
        {
          model: settings.model,
          input: generateDto.message,
          stream: true,
        },
        {
          signal: openAiAbortController.signal,
        },
      )) as OpenAiStream;

      for await (const event of openAiStream) {
        if (clientDisconnected || this.isResponseClosed(response)) {
          break;
        }

        if (event.type === 'response.output_text.delta') {
          if (!generationStarted) {
            generationStarted = true;
            this.writeSse(response, 'status', { status: 'generating' });
          }

          this.writeSse(response, 'content', { delta: event.delta });
          continue;
        }

        if (event.type === 'response.completed') {
          completedNormally = true;
          this.writeSse(response, 'completed', { status: 'completed' });
          this.endResponse(response);
          return;
        }

        if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          throw new Error('OpenAI response did not complete.');
        }
      }

      if (!clientDisconnected) {
        this.endResponse(response);
      }
    } catch (error) {
      if (clientDisconnected || this.isAbortError(error)) {
        return;
      }

      if (!this.isResponseClosed(response)) {
        this.writeSse(response, 'error', {
          message: 'No fue posible completar la generacion.',
        });
        this.endResponse(response);
      }
    } finally {
      request.off('aborted', abortOpenAiStream);
      request.off('close', handleConnectionClosed);
      response.off('close', handleConnectionClosed);
    }
  }

  private getOpenAiSettings(): { apiKey: string; model: string } | null {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY')?.trim();
    const model = this.configService.get<string>('OPENAI_MODEL')?.trim();

    if (!apiKey || !model) {
      return null;
    }

    return { apiKey, model };
  }

  private getClient(apiKey: string): OpenAI {
    if (!this.openaiClient) {
      this.openaiClient = new OpenAI({ apiKey });
    }

    return this.openaiClient;
  }

  private prepareSseResponse(response: Response): void {
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
  }

  private writeSse(response: Response, event: string, data: SsePayload): void {
    if (this.isResponseClosed(response)) {
      return;
    }

    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private endResponse(response: Response): void {
    if (!this.isResponseClosed(response)) {
      response.end();
    }
  }

  private isResponseClosed(response: Response): boolean {
    return response.writableEnded || response.destroyed;
  }

  private isAbortError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    );
  }
}
