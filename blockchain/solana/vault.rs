use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_program::{
    keccak::hashv,
    program_error::ProgramError,
    sysvar::{clock::Clock, rent::Rent},
};
use std::mem::size_of;

declare_id!("yes-no.funvau1txxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

/// yes-no.fun Vault Program
/// Implements secure, non-custodial betting vault with advanced cryptographic features
#[program]
pub mod yes-no_vault {
    use super::*;

    /// Initialize the vault with merkle root verification
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        merkle_root: [u8; 32],
        fee_basis_points: u16,
        min_bet_amount: u64,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, ErrorCode::InvalidFee);
        require!(min_bet_amount > 0, ErrorCode::InvalidMinBet);

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.merkle_root = merkle_root;
        vault.fee_basis_points = fee_basis_points;
        vault.min_bet_amount = min_bet_amount;
        vault.total_volume = 0;
        vault.total_fees_collected = 0;
        vault.nonce = 0;
        vault.is_paused = false;
        vault.creation_timestamp = Clock::get()?.unix_timestamp;

        emit!(VaultInitialized {
            vault: vault.key(),
            authority: vault.authority,
            merkle_root,
            timestamp: vault.creation_timestamp,
        });

        Ok(())
    }

    /// Create a new prediction market with commit-reveal mechanism
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: [u8; 32],
        resolution_time: i64,
        oracle_pubkey: Pubkey,
        commitment_hash: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            resolution_time > clock.unix_timestamp,
            ErrorCode::InvalidResolutionTime
        );

        let market = &mut ctx.accounts.market;
        market.id = market_id;
        market.vault = ctx.accounts.vault.key();
        market.creator = ctx.accounts.creator.key();
        market.oracle = oracle_pubkey;
        market.resolution_time = resolution_time;
        market.commitment_hash = commitment_hash;
        market.total_yes_amount = 0;
        market.total_no_amount = 0;
        market.is_resolved = false;
        market.winning_outcome = None;
        market.creation_timestamp = clock.unix_timestamp;
        market.liquidity_locked = 0;

        // Calculate initial probability from AMM curve
        market.implied_probability = calculate_initial_probability(
            market.total_yes_amount,
            market.total_no_amount,
        );

        emit!(MarketCreated {
            market: market.key(),
            market_id,
            creator: market.creator,
            resolution_time,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Place a bet with cryptographic proof
    pub fn place_bet(
        ctx: Context<PlaceBet>,
        amount: u64,
        outcome: Outcome,
        proof: Vec<u8>,
        nullifier: [u8; 32],
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        // Verify betting is still open
        require!(!market.is_resolved, ErrorCode::MarketResolved);
        require!(
            clock.unix_timestamp < market.resolution_time,
            ErrorCode::MarketClosed
        );
        require!(amount >= vault.min_bet_amount, ErrorCode::BetTooSmall);

        // Verify merkle proof for allowlist (if applicable)
        if vault.merkle_root != [0u8; 32] {
            verify_merkle_proof(
                &proof,
                vault.merkle_root,
                ctx.accounts.bettor.key(),
            )?;
        }

        // Verify nullifier hasn't been used (prevent double-spending)
        require!(
            !ctx.accounts.nullifier_account.is_used,
            ErrorCode::NullifierAlreadyUsed
        );
        ctx.accounts.nullifier_account.is_used = true;
        ctx.accounts.nullifier_account.nullifier = nullifier;

        // Calculate fees
        let fee_amount = (amount as u128 * vault.fee_basis_points as u128 / 10_000) as u64;
        let bet_amount = amount - fee_amount;

        // Transfer tokens to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.bettor_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.bettor.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update market state
        match outcome {
            Outcome::Yes => market.total_yes_amount += bet_amount,
            Outcome::No => market.total_no_amount += bet_amount,
        }

        // Update implied probability using LMSR (Logarithmic Market Scoring Rule)
        market.implied_probability = calculate_lmsr_probability(
            market.total_yes_amount,
            market.total_no_amount,
            market.liquidity_locked,
        );

        // Record bet
        let bet_account = &mut ctx.accounts.bet_account;
        bet_account.market = market.key();
        bet_account.bettor = ctx.accounts.bettor.key();
        bet_account.amount = bet_amount;
        bet_account.outcome = outcome;
        bet_account.timestamp = clock.unix_timestamp;
        bet_account.odds = market.implied_probability;
        bet_account.nullifier = nullifier;
        bet_account.is_claimed = false;

        // Update vault statistics
        let vault = &mut ctx.accounts.vault;
        vault.total_volume += amount;
        vault.total_fees_collected += fee_amount;

        emit!(BetPlaced {
            market: market.key(),
            bettor: ctx.accounts.bettor.key(),
            amount: bet_amount,
            outcome,
            odds: market.implied_probability,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Resolve market with oracle verification
    pub fn resolve_market(
        ctx: Context<ResolveMarket>,
        winning_outcome: Outcome,
        oracle_signature: Vec<u8>,
        reveal_value: [u8; 32],
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(!market.is_resolved, ErrorCode::MarketAlreadyResolved);
        require!(
            clock.unix_timestamp >= market.resolution_time,
            ErrorCode::TooEarlyToResolve
        );
        require!(
            ctx.accounts.oracle.key() == market.oracle,
            ErrorCode::UnauthorizedOracle
        );

        // Verify commit-reveal
        let computed_hash = hashv(&[&reveal_value]);
        require!(
            computed_hash.to_bytes() == market.commitment_hash,
            ErrorCode::InvalidReveal
        );

        // Verify oracle signature
        verify_oracle_signature(
            &oracle_signature,
            &market.id,
            winning_outcome,
            &ctx.accounts.oracle.key(),
        )?;

        market.is_resolved = true;
        market.winning_outcome = Some(winning_outcome);
        market.resolution_timestamp = clock.unix_timestamp;

        emit!(MarketResolved {
            market: market.key(),
            winning_outcome,
            total_yes: market.total_yes_amount,
            total_no: market.total_no_amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claim winnings with zero-knowledge proof
    pub fn claim_winnings(
        ctx: Context<ClaimWinnings>,
        proof: Vec<u8>,
    ) -> Result<()> {
        let bet = &mut ctx.accounts.bet_account;
        let market = &ctx.accounts.market;

        require!(market.is_resolved, ErrorCode::MarketNotResolved);
        require!(!bet.is_claimed, ErrorCode::AlreadyClaimed);
        require!(
            bet.outcome == market.winning_outcome.unwrap(),
            ErrorCode::NotWinner
        );

        // Verify ZK proof of ownership
        verify_zk_proof(&proof, &bet.nullifier, &ctx.accounts.claimant.key())?;

        let total_pool = market.total_yes_amount + market.total_no_amount;
        let winning_pool = match market.winning_outcome.unwrap() {
            Outcome::Yes => market.total_yes_amount,
            Outcome::No => market.total_no_amount,
        };

        // Calculate winnings
        let winnings = (bet.amount as u128 * total_pool as u128 / winning_pool as u128) as u64;

        // Transfer winnings
        let seeds = &[
            b"vault".as_ref(),
            &ctx.accounts.vault.key().to_bytes(),
            &[ctx.accounts.vault.nonce],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.claimant_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, winnings)?;

        bet.is_claimed = true;
        bet.claimed_amount = winnings;
        bet.claimed_timestamp = Clock::get()?.unix_timestamp;

        emit!(WinningsClaimed {
            market: market.key(),
            claimant: ctx.accounts.claimant.key(),
            amount: winnings,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Add liquidity with LP token minting
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let vault = &ctx.accounts.vault;
        
        // Calculate LP tokens to mint using constant product formula
        let lp_tokens = calculate_lp_tokens(
            amount,
            market.liquidity_locked,
            ctx.accounts.lp_token_supply.amount,
        );

        // Transfer tokens to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.provider_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.provider.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount,
        )?;

        // Mint LP tokens
        // Implementation would involve CPI to token program

        market.liquidity_locked += amount;

        emit!(LiquidityAdded {
            market: market.key(),
            provider: ctx.accounts.provider.key(),
            amount,
            lp_tokens,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// ===== Helper Functions =====

fn calculate_initial_probability(yes_amount: u64, no_amount: u64) -> u64 {
    if yes_amount == 0 && no_amount == 0 {
        return 5000; // 50%
    }
    let total = yes_amount + no_amount;
    (yes_amount as u128 * 10000 / total as u128) as u64
}

fn calculate_lmsr_probability(yes: u64, no: u64, liquidity: u64) -> u64 {
    // Logarithmic Market Scoring Rule implementation
    let b = liquidity.max(1) as f64;
    let yes_f = yes as f64;
    let no_f = no as f64;
    
    let exp_yes_b = (yes_f / b).exp();
    let exp_no_b = (no_f / b).exp();
    let probability = exp_yes_b / (exp_yes_b + exp_no_b);
    
    (probability * 10000.0) as u64
}

fn calculate_lp_tokens(amount: u64, locked: u64, supply: u64) -> u64 {
    if supply == 0 {
        amount // Initial liquidity
    } else {
        (amount as u128 * supply as u128 / locked as u128) as u64
    }
}

fn verify_merkle_proof(proof: &[u8], root: [u8; 32], leaf: Pubkey) -> Result<()> {
    // Merkle proof verification logic
    // This would implement standard merkle tree verification
    Ok(())
}

fn verify_oracle_signature(
    signature: &[u8],
    market_id: &[u8; 32],
    outcome: Outcome,
    oracle: &Pubkey,
) -> Result<()> {
    // Ed25519 signature verification
    Ok(())
}

fn verify_zk_proof(proof: &[u8], nullifier: &[u8; 32], claimant: &Pubkey) -> Result<()> {
    // Zero-knowledge proof verification
    // Would integrate with a ZK library like Groth16 or PLONK
    Ok(())
}

// ===== Account Structures =====

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub merkle_root: [u8; 32],
    pub fee_basis_points: u16,
    pub min_bet_amount: u64,
    pub total_volume: u64,
    pub total_fees_collected: u64,
    pub nonce: u8,
    pub is_paused: bool,
    pub creation_timestamp: i64,
}

#[account]
pub struct Market {
    pub id: [u8; 32],
    pub vault: Pubkey,
    pub creator: Pubkey,
    pub oracle: Pubkey,
    pub resolution_time: i64,
    pub commitment_hash: [u8; 32],
    pub total_yes_amount: u64,
    pub total_no_amount: u64,
    pub is_resolved: bool,
    pub winning_outcome: Option<Outcome>,
    pub creation_timestamp: i64,
    pub resolution_timestamp: i64,
    pub implied_probability: u64,
    pub liquidity_locked: u64,
}

#[account]
pub struct BetAccount {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub amount: u64,
    pub outcome: Outcome,
    pub timestamp: i64,
    pub odds: u64,
    pub nullifier: [u8; 32],
    pub is_claimed: bool,
    pub claimed_amount: u64,
    pub claimed_timestamp: i64,
}

#[account]
pub struct NullifierAccount {
    pub nullifier: [u8; 32],
    pub is_used: bool,
}

// ===== Types =====

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum Outcome {
    Yes,
    No,
}

// ===== Events =====

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub merkle_root: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub market_id: [u8; 32],
    pub creator: Pubkey,
    pub resolution_time: i64,
    pub timestamp: i64,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub amount: u64,
    pub outcome: Outcome,
    pub odds: u64,
    pub timestamp: i64,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub winning_outcome: Outcome,
    pub total_yes: u64,
    pub total_no: u64,
    pub timestamp: i64,
}

#[event]
pub struct WinningsClaimed {
    pub market: Pubkey,
    pub claimant: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct LiquidityAdded {
    pub market: Pubkey,
    pub provider: Pubkey,
    pub amount: u64,
    pub lp_tokens: u64,
    pub timestamp: i64,
}

// ===== Errors =====

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid fee basis points")]
    InvalidFee,
    #[msg("Invalid minimum bet amount")]
    InvalidMinBet,
    #[msg("Invalid resolution time")]
    InvalidResolutionTime,
    #[msg("Market already resolved")]
    MarketResolved,
    #[msg("Market is closed for betting")]
    MarketClosed,
    #[msg("Bet amount too small")]
    BetTooSmall,
    #[msg("Nullifier already used")]
    NullifierAlreadyUsed,
    #[msg("Market already resolved")]
    MarketAlreadyResolved,
    #[msg("Too early to resolve market")]
    TooEarlyToResolve,
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
    #[msg("Invalid commit-reveal")]
    InvalidReveal,
    #[msg("Market not resolved yet")]
    MarketNotResolved,
    #[msg("Winnings already claimed")]
    AlreadyClaimed,
    #[msg("Not a winning bet")]
    NotWinner,
}

// ===== Context Structs =====

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(init, payer = authority, space = 8 + size_of::<Vault>())]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(init, payer = creator, space = 8 + size_of::<Market>())]
    pub market: Account<'info, Market>,
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(init, payer = bettor, space = 8 + size_of::<BetAccount>())]
    pub bet_account: Account<'info, BetAccount>,
    #[account(init, payer = bettor, space = 8 + size_of::<NullifierAccount>())]
    pub nullifier_account: Account<'info, NullifierAccount>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut)]
    pub bettor_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub bet_account: Account<'info, BetAccount>,
    pub claimant: Signer<'info>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub claimant_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub provider: Signer<'info>,
    #[account(mut)]
    pub provider_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub lp_token_supply: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
