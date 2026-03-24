use anchor_lang::prelude::*;

declare_id!("SPool111111111111111111111111111111111111111");

/// ShadowPool — Confidential order book execution via Arcium MXE
///
/// Orders are submitted encrypted. The Arcium MXE matches orders
/// without revealing individual order details. Only settlement amounts
/// are written on-chain after matching.
#[program]
pub mod shadowpool {
    use super::*;

    /// Initialize a trading pair pool
    pub fn init_pool(
        ctx: Context<InitPool>,
        pool_id: u64,
        base_mint: Pubkey,
        quote_mint: Pubkey,
        mxe_cluster_offset: u64,
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.pool_id = pool_id;
        pool.base_mint = base_mint;
        pool.quote_mint = quote_mint;
        pool.mxe_cluster_offset = mxe_cluster_offset;
        pool.active = true;
        pool.total_orders = 0;
        pool.total_settlements = 0;

        emit!(PoolInitialized { pool_id, mxe_cluster_offset });
        Ok(())
    }

    /// Submit an encrypted limit order.
    /// Price and size are encrypted — never revealed to the public orderbook.
    pub fn submit_order(
        ctx: Context<SubmitOrder>,
        pool_id: u64,
        side: OrderSide,
        encrypted_price: Vec<u8>,
        encrypted_size: Vec<u8>,
        order_commitment: [u8; 32],
    ) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.active, ShadowPoolError::PoolNotActive);
        require!(encrypted_price.len() <= 64, ShadowPoolError::DataTooLarge);
        require!(encrypted_size.len() <= 64, ShadowPoolError::DataTooLarge);

        let order = &mut ctx.accounts.order;
        order.trader = ctx.accounts.trader.key();
        order.pool_id = pool_id;
        order.side = side;
        order.encrypted_price = encrypted_price;
        order.encrypted_size = encrypted_size;
        order.order_commitment = order_commitment;
        order.status = OrderStatus::Open;
        order.submitted_at = Clock::get()?.unix_timestamp;

        pool.total_orders += 1;

        emit!(OrderSubmitted {
            trader: ctx.accounts.trader.key(),
            pool_id,
            order_commitment,
        });
        Ok(())
    }

    /// Record MXE settlement result after confidential matching.
    pub fn settle_order(
        ctx: Context<SettleOrder>,
        fill_price_lamports: u64,
        fill_size: u64,
        mxe_proof_hash: [u8; 32],
    ) -> Result<()> {
        let order = &mut ctx.accounts.order;
        order.fill_price_lamports = fill_price_lamports;
        order.fill_size = fill_size;
        order.mxe_proof_hash = mxe_proof_hash;
        order.status = OrderStatus::Filled;
        order.settled_at = Clock::get()?.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        pool.total_settlements += 1;

        emit!(OrderSettled {
            trader: order.trader,
            pool_id: order.pool_id,
            fill_size,
            mxe_proof_hash,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct InitPool<'info> {
    #[account(init, payer = authority, space = TradingPool::LEN,
        seeds = [b"pool", &pool_id.to_le_bytes()], bump)]
    pub pool: Account<'info, TradingPool>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct SubmitOrder<'info> {
    #[account(mut, seeds = [b"pool", &pool_id.to_le_bytes()], bump)]
    pub pool: Account<'info, TradingPool>,
    #[account(init, payer = trader, space = Order::LEN,
        seeds = [b"order", trader.key().as_ref(), &Clock::get().unwrap().unix_timestamp.to_le_bytes()],
        bump)]
    pub order: Account<'info, Order>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleOrder<'info> {
    #[account(mut)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [b"pool", &order.pool_id.to_le_bytes()], bump)]
    pub pool: Account<'info, TradingPool>,
    pub authority: Signer<'info>,
}

#[account]
pub struct TradingPool {
    pub authority: Pubkey,
    pub pool_id: u64,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub mxe_cluster_offset: u64,
    pub active: bool,
    pub total_orders: u64,
    pub total_settlements: u64,
}
impl TradingPool {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 32 + 8 + 1 + 8 + 8;
}

#[account]
pub struct Order {
    pub trader: Pubkey,
    pub pool_id: u64,
    pub side: OrderSide,
    pub encrypted_price: Vec<u8>,  // max 64 bytes
    pub encrypted_size: Vec<u8>,   // max 64 bytes
    pub order_commitment: [u8; 32],
    pub status: OrderStatus,
    pub submitted_at: i64,
    pub fill_price_lamports: u64,
    pub fill_size: u64,
    pub mxe_proof_hash: [u8; 32],
    pub settled_at: i64,
}
impl Order {
    pub const LEN: usize = 8 + 32 + 8 + 1 + (4+64) + (4+64) + 32 + 1 + 8 + 8 + 8 + 32 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum OrderSide { Buy, Sell }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum OrderStatus { Open, Filled, Cancelled }

#[event]
pub struct PoolInitialized { pub pool_id: u64, pub mxe_cluster_offset: u64 }
#[event]
pub struct OrderSubmitted { pub trader: Pubkey, pub pool_id: u64, pub order_commitment: [u8; 32] }
#[event]
pub struct OrderSettled { pub trader: Pubkey, pub pool_id: u64, pub fill_size: u64, pub mxe_proof_hash: [u8; 32] }

#[error_code]
pub enum ShadowPoolError {
    #[msg("Pool is not active")]
    PoolNotActive,
    #[msg("Encrypted data too large")]
    DataTooLarge,
}
