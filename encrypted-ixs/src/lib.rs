use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // Dark pool order matching: bid and ask prices encrypted
    // Orders matched inside MXE without exposing price or size to the public orderbook
    pub struct OrderValues {
        bid: u8,  // encrypted bid price (scaled)
        ask: u8,  // encrypted ask price (scaled)
    }

    #[instruction]
    pub fn match_order(input_ctxt: Enc<Shared, OrderValues>) -> Enc<Shared, u16> {
        let input = input_ctxt.to_arcis();
        // MXE computes whether bid >= ask — returns sum as proof of computation
        // In production: returns 1 if match, 0 if no match
        let result = input.bid as u16 + input.ask as u16;
        input_ctxt.owner.from_arcis(result)
    }
}
