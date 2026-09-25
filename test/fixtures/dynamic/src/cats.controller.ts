import { Controller, Get } from './decorators';

@Controller('cats')
export class CatsController {
  @Get()
  findAll(): string[] {
    return listCats();
  }
}

function listCats(): string[] {
  return ['tom', 'felix'];
}
