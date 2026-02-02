import type { Abi } from 'abi-wan-kanabi';
import type {
  AbiEventMember,
  StringToPrimitiveType,
  ExtractAbiEventNames,
} from 'abi-wan-kanabi/kanabi';

export type AbiEventStruct = {
  type: 'event';
  name: string;
  kind: 'struct';
  members: AbiEventMember[];
};

export type AbiMember = {
  name: string;
  type: string;
};

export type AbiEventEnum = {
  type: 'event';
  name: string;
  kind: 'enum';
  variants: AbiEventMember[];
};

export type AbiEvent = AbiEventStruct | AbiEventEnum;

export type AbiItem = Abi[number];

export type DecodeEventArgs<
  TAbi extends Abi = Abi,
  TEventName extends ExtractAbiEventNames<TAbi> = ExtractAbiEventNames<TAbi>,
  TStrict extends boolean = true,
> = {
  abi: TAbi;
  eventName: TEventName;
  event: Event;
  strict?: TStrict;
};

export type DecodedEvent<
  TAbi extends Abi = Abi,
  TEventName extends ExtractAbiEventNames<TAbi> = ExtractAbiEventNames<TAbi>,
> = Event & {
  eventName: TEventName;
  args: EventToPrimitiveType<TAbi, TEventName>;
};

export type DecodeEventReturn<
  TAbi extends Abi = Abi,
  TEventName extends ExtractAbiEventNames<TAbi> = ExtractAbiEventNames<TAbi>,
  TStrict extends boolean = true,
> = TStrict extends true ? DecodedEvent<TAbi, TEventName> : DecodedEvent<TAbi, TEventName> | null;

// Helper type to resolve the payload type of a nested variant.
// when the type name corresponds to an event; resolves it using EventToPrimitiveType,
export type ResolveNestedVariantType<
  TAbi extends Abi,
  TTypeName extends string,
> = EventToPrimitiveType<TAbi, TTypeName>; // resolve its structure recursively

// Helper type to convert a variant member (nested or flat) into its corresponding tagged union part(s).
export type VariantToTaggedUnion<
  TAbi extends Abi,
  TVariant extends AbiEventMember,
> = TVariant extends { kind: 'nested' }
  ? // Nested: Use the helper to resolve the payload type.
    { _tag: TVariant['name'] } & {
      [K in TVariant['name']]: ResolveNestedVariantType<TAbi, TVariant['type']>;
    }
  : TVariant extends { kind: 'flat' }
    ? // Flat: Recursively call EventToPrimitiveType on the referenced event type.
      // This will return the union of tagged types for the nested event.
      EventToPrimitiveType<TAbi, TVariant['type']>
    : never; // Should not happen for valid ABIs

// Main type to convert an event definition to its TS representation.
// This implementation only looks for struct events, ignoring enum events completely
export type EventToPrimitiveType<TAbi extends Abi, TEventName extends string> = {
  [K in keyof TAbi]: TAbi[K] extends {
    type: 'event';
    name: TEventName;
    kind: 'struct';
    members: infer TMembers extends readonly AbiEventMember[];
  }
    ? {
        [Member in TMembers[number] as Member['name']]: Member['type'] extends 'core::starknet::contract_address::ContractAddress'
          ? bigint
          : StringToPrimitiveType<TAbi, Member['type']>;
      }
    : never;
}[number];

export function isEventAbi(item: AbiItem): item is AbiEvent {
  return item.type === 'event';
}

export function isStructEventAbi(item: AbiItem): item is AbiEventStruct {
  return isEventAbi(item) && item.kind === 'struct';
}

export function isEnumEventAbi(item: AbiItem): item is AbiEventEnum {
  return isEventAbi(item) && item.kind === 'enum';
}
