// 개발자: 신현묵 <8508132+seanshin@users.noreply.github.com>
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ContractAddressbookService } from '../application/contract-addressbook.service';
import { ApiKeyGuard, RequireScope } from './guards/api-key.guard';
import { AddressbookAddDto, AddressbookUpdateDto } from './dto';
import { ApiTags } from '@nestjs/swagger';

/**
 * 전자계약 발송/수신 이메일 주소록 — 자주 발송하는 외부 상대방 연락처 관리.
 * 조회 contracts:read, 편집 contracts:write. 플래그 GENERAL_CONTRACTS OFF 시 404.
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
@ApiTags('전자계약')
@Controller('v1/contracts/addressbook')
export class ContractAddressbookController {
  constructor(private readonly svc: ContractAddressbookService) {}

  /** 계약 상대방 주소록 조회 — 자주 쓰는 서명자 정보. */
  @Get()
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:read')
  async list(@Query('q') q?: string) {
    return { data: await this.svc.list(q) };
  }

  /** 계약 상대방 주소록 등록. */
  @Post()
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async add(@Body() dto: AddressbookAddDto) {
    return { data: await this.svc.add(dto) };
  }

  /** 계약 상대방 주소록 수정. */
  @Patch(':id')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async update(@Param('id') id: string, @Body() dto: AddressbookUpdateDto) {
    return { data: await this.svc.update(id, dto) };
  }

  /** 계약 상대방 주소록 삭제. */
  @Delete(':id')
  @UseGuards(ApiKeyGuard)
  @RequireScope('contracts:write')
  async remove(@Param('id') id: string) {
    return { data: await this.svc.remove(id) };
  }
}
