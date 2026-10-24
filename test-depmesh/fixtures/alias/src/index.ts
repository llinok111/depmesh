// alias import: @app/util -> ./src/util.ts
import { double } from '@app/util';
// relative import
import { triple } from './math';
// type-only import
import type { Options } from '@app/types';

export const run = (value: number, options: Options): number => double(triple(value)) + options.bias;
