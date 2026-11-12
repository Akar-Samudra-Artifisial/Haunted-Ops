import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { expect, it } from 'vitest';

class Dep {}

@Injectable()
class Holder {
  constructor(readonly dep: Dep) {}
}

it('api test setup runs and emits decorator metadata', () => {
  expect(Reflect.getMetadata('design:paramtypes', Holder)).toEqual([Dep]);
});
