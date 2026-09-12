import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { GenerateDto } from './dto/generate.dto';
import { GenerationService } from './generation.service';

@Controller('api/generate')
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post()
  async generate(
    @Body() generateDto: GenerateDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    await this.generationService.streamGeneration(generateDto, request, response);
  }
}
