// Generated ABI for StarknetERC20
// Contract Address: 0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d

export const abi = [
  {
    "name": "LendingManagerImpl",
    "type": "impl",
    "interface_name": "stormbit_contracts_cairo::interfaces::lending_manager::ILendingManager"
  },
  {
    "name": "stormbit_contracts_cairo::types::term_fee::TermFee",
    "type": "struct",
    "members": [
      {
        "name": "value",
        "type": "core::integer::u32"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::types::term_currency::TermCurrency",
    "type": "struct",
    "members": [
      {
        "name": "value",
        "type": "core::felt252"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::types::term_update::TermUpdate",
    "type": "struct",
    "members": [
      {
        "name": "value",
        "type": "core::integer::u8"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::types::term_key::TermKey",
    "type": "struct",
    "members": [
      {
        "name": "lender",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "term_fee",
        "type": "stormbit_contracts_cairo::types::term_fee::TermFee"
      },
      {
        "name": "term_currency",
        "type": "stormbit_contracts_cairo::types::term_currency::TermCurrency"
      },
      {
        "name": "update",
        "type": "stormbit_contracts_cairo::types::term_update::TermUpdate"
      },
      {
        "name": "hooks",
        "type": "core::starknet::contract_address::ContractAddress"
      }
    ]
  },
  {
    "name": "core::integer::u256",
    "type": "struct",
    "members": [
      {
        "name": "low",
        "type": "core::integer::u128"
      },
      {
        "name": "high",
        "type": "core::integer::u128"
      }
    ]
  },
  {
    "name": "core::bool",
    "type": "enum",
    "variants": [
      {
        "name": "False",
        "type": "()"
      },
      {
        "name": "True",
        "type": "()"
      }
    ]
  },
  {
    "name": "alexandria_math::i257::i257",
    "type": "struct",
    "members": [
      {
        "name": "abs",
        "type": "core::integer::u256"
      },
      {
        "name": "is_negative",
        "type": "core::bool"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::TermModifyPositionParams",
    "type": "struct",
    "members": [
      {
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "owner",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "position_delta",
        "type": "alexandria_math::i257::i257"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::TermSettleParams",
    "type": "struct",
    "members": [
      {
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "owners",
        "type": "core::array::Array::<core::starknet::contract_address::ContractAddress>"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::types::loan_key::LoanKey",
    "type": "struct",
    "members": [
      {
        "name": "borrower",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "amount",
        "type": "core::integer::u256"
      },
      {
        "name": "amount_delta",
        "type": "core::integer::u256"
      },
      {
        "name": "deadline",
        "type": "core::integer::u128"
      },
      {
        "name": "module",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "module_data_hash",
        "type": "core::felt252"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::LoanInitializeParams",
    "type": "struct",
    "members": [
      {
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "amount",
        "type": "core::integer::u256"
      },
      {
        "name": "amount_delta",
        "type": "core::integer::u256"
      },
      {
        "name": "allocation_time",
        "type": "core::integer::u64"
      },
      {
        "name": "module_data",
        "type": "core::array::Array::<core::felt252>"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::types::loan_id::LoanId",
    "type": "struct",
    "members": [
      {
        "name": "value",
        "type": "core::felt252"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::LoanCancelParams",
    "type": "struct",
    "members": [
      {
        "name": "hook_data",
        "type": "core::array::Array::<core::felt252>"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::AllocateParams",
    "type": "struct",
    "members": [
      {
        "name": "allocation",
        "type": "alexandria_math::i257::i257"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::RepayParams",
    "type": "struct",
    "members": [
      {
        "name": "repay_amount",
        "type": "core::integer::u256"
      },
      {
        "name": "module_data",
        "type": "core::array::Array::<core::felt252>"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::libraries::loan::LoanStatus",
    "type": "enum",
    "variants": [
      {
        "name": "NONE",
        "type": "()"
      },
      {
        "name": "PENDING",
        "type": "()"
      },
      {
        "name": "EXECUTED",
        "type": "()"
      },
      {
        "name": "REPAID",
        "type": "()"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::interfaces::lending_manager::ILendingManager",
    "type": "interface",
    "items": [
      {
        "name": "pause",
        "type": "function",
        "inputs": [],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "term_initialize",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "term_modify_position",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "params",
            "type": "stormbit_contracts_cairo::interfaces::lending_manager::TermModifyPositionParams"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "term_settle",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "params",
            "type": "stormbit_contracts_cairo::interfaces::lending_manager::TermSettleParams"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "loan_initialize",
        "type": "function",
        "inputs": [
          {
            "name": "loan_key",
            "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
          },
          {
            "name": "params",
            "type": "stormbit_contracts_cairo::interfaces::lending_manager::LoanInitializeParams"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [
          {
            "type": "stormbit_contracts_cairo::types::loan_id::LoanId"
          }
        ],
        "state_mutability": "external"
      },
      {
        "name": "loan_cancel",
        "type": "function",
        "inputs": [
          {
            "name": "loan_key",
            "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
          },
          {
            "name": "params",
            "type": "stormbit_contracts_cairo::interfaces::lending_manager::LoanCancelParams"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "allocate",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "loan_key",
            "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
          },
          {
            "name": "params",
            "type": "stormbit_contracts_cairo::interfaces::lending_manager::AllocateParams"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "repay",
        "type": "function",
        "inputs": [
          {
            "name": "loan_key",
            "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
          },
          {
            "name": "params",
            "type": "stormbit_contracts_cairo::interfaces::lending_manager::RepayParams"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "term_start_update",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "term_complete_update",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "hook_data",
            "type": "core::array::Array::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "name": "term_update_time",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "external"
      },
      {
        "name": "term_update_params",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "external"
      },
      {
        "name": "get_term_on_loan_amounts",
        "type": "function",
        "inputs": [
          {
            "name": "loan_key",
            "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
          },
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u256"
          }
        ],
        "state_mutability": "view"
      },
      {
        "name": "get_position",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "token",
            "type": "core::starknet::contract_address::ContractAddress"
          },
          {
            "name": "owner",
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u256"
          }
        ],
        "state_mutability": "view"
      },
      {
        "name": "get_loan_data",
        "type": "function",
        "inputs": [
          {
            "name": "loan_key",
            "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
          }
        ],
        "outputs": [
          {
            "type": "(core::integer::u256, stormbit_contracts_cairo::libraries::loan::LoanStatus, core::integer::u64, core::integer::u64)"
          }
        ],
        "state_mutability": "view"
      },
      {
        "name": "get_term_balance",
        "type": "function",
        "inputs": [
          {
            "name": "term_key",
            "type": "stormbit_contracts_cairo::types::term_key::TermKey"
          },
          {
            "name": "token",
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u256"
          }
        ],
        "state_mutability": "view"
      }
    ]
  },
  {
    "name": "stormbit_contracts_cairo::types::term_id::TermId",
    "type": "struct",
    "members": [
      {
        "name": "value",
        "type": "core::felt252"
      }
    ]
  },
  {
    "kind": "struct",
    "name": "stormbit_contracts_cairo::lending_manager::LendingManager::TermModifyPosition",
    "type": "event",
    "members": [
      {
        "kind": "data",
        "name": "term_id",
        "type": "stormbit_contracts_cairo::types::term_id::TermId"
      },
      {
        "kind": "data",
        "name": "owner",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "kind": "data",
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "kind": "data",
        "name": "position_delta",
        "type": "alexandria_math::i257::i257"
      }
    ]
  },
  {
    "kind": "struct",
    "name": "stormbit_contracts_cairo::lending_manager::LendingManager::TermInitialized",
    "type": "event",
    "members": [
      {
        "kind": "data",
        "name": "term_id",
        "type": "stormbit_contracts_cairo::types::term_id::TermId"
      },
      {
        "kind": "data",
        "name": "term_key",
        "type": "stormbit_contracts_cairo::types::term_key::TermKey"
      }
    ]
  },
  {
    "kind": "struct",
    "name": "stormbit_contracts_cairo::lending_manager::LendingManager::LoanInitialized",
    "type": "event",
    "members": [
      {
        "kind": "data",
        "name": "loan_id",
        "type": "stormbit_contracts_cairo::types::loan_id::LoanId"
      },
      {
        "kind": "data",
        "name": "loan_key",
        "type": "stormbit_contracts_cairo::types::loan_key::LoanKey"
      }
    ]
  },
  {
    "kind": "enum",
    "name": "stormbit_contracts_cairo::lending_manager::LendingManager::Event",
    "type": "event",
    "variants": [
      {
        "kind": "nested",
        "name": "TermModifyPosition",
        "type": "stormbit_contracts_cairo::lending_manager::LendingManager::TermModifyPosition"
      },
      {
        "kind": "nested",
        "name": "TermInitialized",
        "type": "stormbit_contracts_cairo::lending_manager::LendingManager::TermInitialized"
      },
      {
        "kind": "nested",
        "name": "LoanInitialized",
        "type": "stormbit_contracts_cairo::lending_manager::LendingManager::LoanInitialized"
      }
    ]
  }
] as const;

export default abi;
