-- Chess engine for PostgreSQL 17: a chess.js 1.4.0 equivalent in pure
-- PL/pgSQL. Bitboards on bigint with LSB/MSB bit math instead of string
-- operations; semantics fully aligned with chess.js.

-- Positions are bitboards on bigint (64-bit). Square numbering: 0..63,
-- a1=0, b1=1, ..., h1=7, a2=8, ..., h8=63.
--
-- Public API:
--   chess_parse_fen(fen text)                 -> chess_board
--   chess_to_fen(b chess_board[, force_ep])   -> text
--   chess_is_square_attacked(b, sq, by_white) -> boolean
--   chess_validate_move(fen text, uci text)   -> boolean
--   chess_validate_move_b(b chess_board, uci) -> boolean  (core, no parse_fen)
--   chess_get_moves(fen text)                 -> text[]
--   chess_play_move(fen text, uci text)       -> chess_move_result
--   chess_play_move_b(b chess_board, uci)     -> chess_move_result (core, no parse_fen)
--   chess_san(fen text, uci text)             -> text  (thin wrapper, see 03_functions_core.sql)
--   chess_san_b(b, uci, is_check, is_mate)    -> text  (SAN core: no parse_fen,
--                                                       no play_move, no move generation)
--   chess_is_insufficient_material(b)         -> boolean

-- 1. Data types


DROP TYPE IF EXISTS chess_move_result CASCADE;
DROP TYPE IF EXISTS chess_analysis CASCADE;
DROP TYPE IF EXISTS chess_board CASCADE;

CREATE TYPE chess_board AS (
    wp          bigint,   -- white pawns
    wn          bigint,   -- white knights
    wb          bigint,   -- white bishops
    wr          bigint,   -- white rooks
    wq          bigint,   -- white queens
    wk          bigint,   -- white king
    bp          bigint,   -- black pawns
    bn          bigint,   -- black knights
    bb          bigint,   -- black bishops
    br          bigint,   -- black rooks
    bq          bigint,   -- black queens
    bk          bigint,   -- black king
    white_to_move boolean,-- side to move (true = white)
    castling    smallint, -- castling rights: 1=K(0-0), 2=Q(0-0-0), 4=k, 8=q
    ep          smallint, -- en passant square (0..63) or -1
    halfmove    int,      -- half-moves since the last capture or pawn move
    fullmove    int       -- move number (increments after black)
);

CREATE TYPE chess_analysis AS (
    checkers    bigint,   -- enemy pieces attacking the king
    checkmask   bigint,   -- block/capture candidate squares (all 64 = -1 when no check)
    pins        bigint,   -- pinned pieces of the side to move
    pinrays     bigint[]  -- pinrays[sq+1] = allowed move segment for a pinned piece on sq
);

CREATE TYPE chess_move_result AS (
    is_legal        boolean,  -- whether the move is legal
    fen             text,     -- new FEN (NULL for an illegal move)
    is_check        boolean,  -- check given to the opponent
    is_game_over    boolean,  -- whether the game ended
    result          text,     -- '1-0', '0-1', '1/2-1/2' or '*' (game continues)
    reason          text      -- 'checkmate', 'stalemate', 'insufficient_material',
                              -- 'fifty_moves', 'illegal_move', NULL
);


-- 2. Basic utilities


-- Bit index via pure bit math, no strings.
-- bit_count((p_bit - 1)) = number of ones below the bit = its index.
-- Edge case: p_bit = -9223372036854775808 (only bit 63, square h8) makes
-- p_bit - 1 overflow the signed bigint, so 63 is returned by constant.
-- p_bit = 0 yields bit_count(-1::bit(64)) = 64, the legacy "garbage" 64.
-- No STRICT: the attribute blocks SQL inlining from PL/pgSQL (~10x slower).
-- NULL input still produces NULL through the strict expression operators,
-- so observed behavior matches STRICT.
CREATE OR REPLACE FUNCTION chess_bit_index(p_bit bigint)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN p_bit = x'8000000000000000'::bigint THEN 63
                ELSE bit_count((p_bit - 1)::bit(64)) END;
$$;

-- Number of set bits (popcount).
CREATE OR REPLACE FUNCTION chess_popcount(p_bb bigint)
RETURNS int LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT bit_count(p_bb::bit(64));
$$;

-- Least significant bit index without string operations; string
-- conversion was the main hot spot of move iteration. The LSB is
-- isolated by two's complement: LSB = p_bb & -p_bb, and its index is
-- bit_count((LSB - 1)::bit(64)), the count of zeros to the right.
-- Edge case: p_bb = -9223372036854775808 (only bit 63, square h8)
-- overflows the unary minus, so 63 is returned by constant.
-- No STRICT: the attribute blocks inlining from PL/pgSQL; NULL input
-- still yields NULL through strict expression operators.
CREATE OR REPLACE FUNCTION chess_lsb_index(p_bb bigint)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE WHEN p_bb = x'8000000000000000'::bigint THEN 63
                ELSE bit_count(((p_bb & -p_bb) - 1)::bit(64)) END;
$$;

-- Square 0..63 to algebraic name ('e4').
CREATE OR REPLACE FUNCTION chess_sq_name(p_sq int)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT chr(97 + (p_sq & 7)) || ((p_sq >> 3) + 1)::text;
$$;

-- Algebraic name ('e4') to square 0..63.
CREATE OR REPLACE FUNCTION chess_sq_from_name(p_name text)
RETURNS int LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT (ascii(p_name) - 97) + 8 * (ascii(substr(p_name, 2, 1)) - 49);
$$;


-- 3. FEN parser to chess_board (validation aligned with chess.js validateFen)


CREATE OR REPLACE FUNCTION chess_parse_fen(p_fen text)
RETURNS chess_board LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v         chess_board := (0,0,0,0,0,0, 0,0,0,0,0,0, true, 0, -1, 0, 1)::chess_board;
    v_fields  text;
    v_pos     text;
    v_row     text;
    v_r       int;
    v_f       int;
    v_i       int;
    v_c       text;
    v_sq      int;
    v_bit     bigint;
    v_ntok    int;
BEGIN
    v_fields := trim(regexp_replace(p_fen, '\s+', ' ', 'g'));
    -- pad short FENs like chess.js load(): missing trailing fields
    -- become '-', '-', '0', '1'
    v_ntok := array_length(string_to_array(v_fields, ' '), 1);
    IF v_ntok IS NULL OR v_ntok < 2 THEN
        RAISE EXCEPTION 'FEN: требуется минимум позиция и сторона хода';
    END IF;
    IF v_ntok = 2 THEN v_fields := v_fields || ' - - 0 1';
    ELSIF v_ntok = 3 THEN v_fields := v_fields || ' - 0 1';
    ELSIF v_ntok = 4 THEN v_fields := v_fields || ' 0 1';
    ELSIF v_ntok = 5 THEN v_fields := v_fields || ' 1';
    END IF;

    v_pos    := split_part(v_fields, ' ', 1);
    IF v_pos = '' THEN
        RAISE EXCEPTION 'FEN: пустое описание позиции';
    END IF;
    IF split_part(v_pos, '/', 9) <> '' THEN
        RAISE EXCEPTION 'FEN: больше 8 рядов';
    END IF;

    -- piece placement
    FOR v_r IN 1..8 LOOP
        v_row := split_part(v_pos, '/', v_r);
        IF v_row = '' THEN
            RAISE EXCEPTION 'FEN: меньше 8 рядов';
        END IF;
        v_f := 0;
        FOR v_i IN 1..length(v_row) LOOP
            v_c := substr(v_row, v_i, 1);
            IF v_c BETWEEN '1' AND '8' THEN
                v_f := v_f + v_c::int;
            ELSE
                IF v_f > 7 THEN
                    RAISE EXCEPTION 'FEN: переполнение ряда %', v_r;
                END IF;
                v_sq  := (8 - v_r) * 8 + v_f;
                v_bit := 1::bigint << v_sq;
                CASE v_c
                    WHEN 'P' THEN v.wp := v.wp | v_bit;
                    WHEN 'N' THEN v.wn := v.wn | v_bit;
                    WHEN 'B' THEN v.wb := v.wb | v_bit;
                    WHEN 'R' THEN v.wr := v.wr | v_bit;
                    WHEN 'Q' THEN v.wq := v.wq | v_bit;
                    WHEN 'K' THEN v.wk := v.wk | v_bit;
                    WHEN 'p' THEN v.bp := v.bp | v_bit;
                    WHEN 'n' THEN v.bn := v.bn | v_bit;
                    WHEN 'b' THEN v.bb := v.bb | v_bit;
                    WHEN 'r' THEN v.br := v.br | v_bit;
                    WHEN 'q' THEN v.bq := v.bq | v_bit;
                    WHEN 'k' THEN v.bk := v.bk | v_bit;
                    ELSE RAISE EXCEPTION 'FEN: недопустимый символ "%"', v_c;
                END CASE;
                v_f := v_f + 1;
            END IF;
        END LOOP;
        IF v_f <> 8 THEN
            RAISE EXCEPTION 'FEN: ряд % описывает % полей', v_r, v_f;
        END IF;
        -- chess.js criterion 11: no pawns on ranks 1/8
        IF v_r IN (1, 8) AND (v_row ~ '[Pp]') THEN
            RAISE EXCEPTION 'FEN: пешка на крайней горизонтали';
        END IF;
    END LOOP;

    -- side to move
    CASE split_part(v_fields, ' ', 2)
        WHEN 'w' THEN v.white_to_move := true;
        WHEN 'b' THEN v.white_to_move := false;
        ELSE RAISE EXCEPTION 'FEN: сторона хода должна быть "w" или "b"';
    END CASE;

    -- castling rights (chess.js tolerates '-' inside the field, e.g. 'K-')
    v_row := split_part(v_fields, ' ', 3);
    IF v_row IS NULL OR v_row = '' OR v_row = '-' THEN
        v.castling := 0;
    ELSE
        IF v_row !~ '^[-KQkq]+$' THEN
            RAISE EXCEPTION 'FEN: неверные права рокировки "%"', v_row;
        END IF;
        IF position('K' in v_row) > 0 THEN v.castling := v.castling | 1; END IF;
        IF position('Q' in v_row) > 0 THEN v.castling := v.castling | 2; END IF;
        IF position('k' in v_row) > 0 THEN v.castling := v.castling | 4; END IF;
        IF position('q' in v_row) > 0 THEN v.castling := v.castling | 8; END IF;
    END IF;

    -- en passant square: format and consistency with the side to move
    -- (chess.js criterion 9: the ep rank cannot point at the side that
    -- would capture; ep=3 is invalid with white to move, ep=6 with black)
    v_row := split_part(v_fields, ' ', 4);
    IF v_row IS NULL OR v_row = '' OR v_row = '-' THEN
        v.ep := -1;
    ELSE
        IF v_row !~ '^[a-h][36]$' THEN
            RAISE EXCEPTION 'FEN: неверное поле взятия на проходе "%"', v_row;
        END IF;
        IF (substr(v_row, 2, 1) = '3' AND v.white_to_move)
           OR (substr(v_row, 2, 1) = '6' AND NOT v.white_to_move) THEN
            RAISE EXCEPTION 'FEN: ep-поле "%" не согласовано со стороной хода', v_row;
        END IF;
        v.ep := chess_sq_from_name(v_row);
    END IF;

    -- counters
    v.halfmove := coalesce(nullif(split_part(v_fields, ' ', 5), '')::int, 0);
    v.fullmove := coalesce(nullif(split_part(v_fields, ' ', 6), '')::int, 1);
    IF v.halfmove < 0 THEN
        RAISE EXCEPTION 'FEN: счётчик полуходов должен быть >= 0';
    END IF;
    IF v.fullmove < 1 THEN
        RAISE EXCEPTION 'FEN: номер хода должен быть > 0';
    END IF;

    -- exactly one king per side
    IF chess_popcount(v.wk) <> 1 OR chess_popcount(v.bk) <> 1 THEN
        RAISE EXCEPTION 'FEN: требуется ровно по одному королю каждой стороны';
    END IF;

    RETURN v;
END $$;


-- 4. chess_board serialization to FEN.
--    The ep field is printed only when a legal en passant capture exists
--    (a pawn of the side to move stands beside the captured pawn and the
--    capture would not leave the king in check): chess.js 1.4.0 fen() semantics.
--    p_force_ep = true prints ep unconditionally (FIDE-canonical output).


CREATE OR REPLACE FUNCTION chess_to_fen(p_b chess_board, p_force_ep boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v_placement text := '';
    v_rank      text;
    v_f         int;
    v_r         int;
    v_empty     int;
    v_c         text;
    v_ep_out    text;
    v_from      int;
    v_from2     int;
BEGIN
    FOR v_r IN REVERSE 7..0 LOOP
        v_rank := ''; v_empty := 0;
        FOR v_f IN 0..7 LOOP
            v_c := NULL;
            IF    (p_b.wp & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'P';
            ELSIF (p_b.wn & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'N';
            ELSIF (p_b.wb & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'B';
            ELSIF (p_b.wr & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'R';
            ELSIF (p_b.wq & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'Q';
            ELSIF (p_b.wk & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'K';
            ELSIF (p_b.bp & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'p';
            ELSIF (p_b.bn & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'n';
            ELSIF (p_b.bb & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'b';
            ELSIF (p_b.br & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'r';
            ELSIF (p_b.bq & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'q';
            ELSIF (p_b.bk & (1::bigint << (v_r*8 + v_f))) <> 0 THEN v_c := 'k';
            END IF;
            IF v_c IS NULL THEN
                v_empty := v_empty + 1;
            ELSE
                IF v_empty > 0 THEN v_rank := v_rank || v_empty::text; v_empty := 0; END IF;
                v_rank := v_rank || v_c;
            END IF;
        END LOOP;
        IF v_empty > 0 THEN v_rank := v_rank || v_empty::text; END IF;
        IF v_placement <> '' THEN v_placement := v_placement || '/'; END IF;
        v_placement := v_placement || v_rank;
    END LOOP;

    -- ep field: print only when a legal en passant capture exists
    v_ep_out := '-';
    IF p_b.ep >= 0 AND p_force_ep THEN
        v_ep_out := chess_sq_name(p_b.ep);
    ELSIF p_b.ep >= 0 THEN
        IF p_b.white_to_move THEN
            -- white pawn captures ep from ep-7 (file(ep) < 7) and ep-9 (file(ep) > 0)
            v_from := p_b.ep - 7;
            v_from2 := p_b.ep - 9;
            IF (v_from >= 0 AND (p_b.ep & 7) < 7
                AND (p_b.wp & (1::bigint << v_from)) <> 0
                AND chess_move_safe(p_b, v_from, p_b.ep))
            OR (v_from2 >= 0 AND (p_b.ep & 7) > 0
                AND (p_b.wp & (1::bigint << v_from2)) <> 0
                AND chess_move_safe(p_b, v_from2, p_b.ep)) THEN
                v_ep_out := chess_sq_name(p_b.ep);
            END IF;
        ELSE
            -- black pawn captures ep from ep+7 (file(ep) > 0) and ep+9 (file(ep) < 7)
            v_from := p_b.ep + 7;
            v_from2 := p_b.ep + 9;
            IF (v_from <= 63 AND (p_b.ep & 7) > 0
                AND (p_b.bp & (1::bigint << v_from)) <> 0
                AND chess_move_safe(p_b, v_from, p_b.ep))
            OR (v_from2 <= 63 AND (p_b.ep & 7) < 7
                AND (p_b.bp & (1::bigint << v_from2)) <> 0
                AND chess_move_safe(p_b, v_from2, p_b.ep)) THEN
                v_ep_out := chess_sq_name(p_b.ep);
            END IF;
        END IF;
    END IF;

    RETURN v_placement
        || ' ' || CASE WHEN p_b.white_to_move THEN 'w' ELSE 'b' END
        || ' ' || CASE WHEN p_b.castling = 0 THEN '-' ELSE concat(
               CASE WHEN (p_b.castling & 1) <> 0 THEN 'K' END,
               CASE WHEN (p_b.castling & 2) <> 0 THEN 'Q' END,
               CASE WHEN (p_b.castling & 4) <> 0 THEN 'k' END,
               CASE WHEN (p_b.castling & 8) <> 0 THEN 'q' END) END
        || ' ' || v_ep_out
        || ' ' || p_b.halfmove::text
        || ' ' || p_b.fullmove::text;
END $$;


-- 5. Piece attacks


CREATE OR REPLACE FUNCTION chess_knight_att(p_sq int)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    -- 8 knight jumps via shifts with file masks; right shifts go through
    -- ::bit(64) because bigint >> sign-extends.
    SELECT ((((1::bigint << p_sq) & x'7F7F7F7F7F7F7F7F'::bigint) << 17)
          | (((1::bigint << p_sq) & x'FEFEFEFEFEFEFEFE'::bigint) << 15)
          | (((1::bigint << p_sq) & x'3F3F3F3F3F3F3F3F'::bigint) << 10)
          | (((1::bigint << p_sq) & x'FCFCFCFCFCFCFCFC'::bigint) << 6)
          | ((((1::bigint << p_sq) & x'3F3F3F3F3F3F3F3F'::bigint)::bit(64)) >> 6)::bigint
          | ((((1::bigint << p_sq) & x'FCFCFCFCFCFCFCFC'::bigint)::bit(64)) >> 10)::bigint
          | ((((1::bigint << p_sq) & x'7F7F7F7F7F7F7F7F'::bigint)::bit(64)) >> 15)::bigint
          | ((((1::bigint << p_sq) & x'FEFEFEFEFEFEFEFE'::bigint)::bit(64)) >> 17)::bigint);
$$;

CREATE OR REPLACE FUNCTION chess_king_att(p_sq int)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT ((((1::bigint << p_sq) & x'FEFEFEFEFEFEFEFE'::bigint)::bit(64)) >> 1)::bigint
          | ((((1::bigint << p_sq) & x'7F7F7F7F7F7F7F7F'::bigint) << 1))
          |  ((1::bigint << p_sq) << 8)
          | ((((1::bigint << p_sq))::bit(64)) >> 8)::bigint
          | (((1::bigint << p_sq) & x'7F7F7F7F7F7F7F7F'::bigint) << 9)
          | (((1::bigint << p_sq) & x'FEFEFEFEFEFEFEFE'::bigint) << 7)
          | ((((1::bigint << p_sq) & x'7F7F7F7F7F7F7F7F'::bigint)::bit(64)) >> 7)::bigint
          | ((((1::bigint << p_sq) & x'FEFEFEFEFEFEFEFE'::bigint)::bit(64)) >> 9)::bigint;
$$;

-- Sliding piece moves from p_sq with occupancy p_occ (ray up to and
-- including the blocker). p_diag = true for diagonals, false for lines.
CREATE OR REPLACE FUNCTION chess_slider_att(p_occ bigint, p_sq int, p_diag boolean)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v_f    int := p_sq & 7;
    v_r    int := p_sq >> 3;
    v_d    int[] := CASE WHEN p_diag
               THEN ARRAY[1,1, 1,-1, -1,1, -1,-1]
               ELSE ARRAY[1,0, -1,0, 0,1, 0,-1] END;
    v_res  bigint := 0;
    v_i    int;
    v_df   int;
    v_dr   int;
    v_nf   int;
    v_nr   int;
    v_s    int;
    v_bit  bigint;
BEGIN
    FOR v_i IN 0..3 LOOP
        v_df := v_d[v_i*2 + 1];
        v_dr := v_d[v_i*2 + 2];
        v_nf := v_f + v_df;
        v_nr := v_r + v_dr;
        WHILE v_nf BETWEEN 0 AND 7 AND v_nr BETWEEN 0 AND 7 LOOP
            v_s    := v_nr*8 + v_nf;
            v_bit  := 1::bigint << v_s;
            v_res  := v_res | v_bit;
            IF (p_occ & v_bit) <> 0 THEN EXIT; END IF;
            v_nf := v_nf + v_df;
            v_nr := v_nr + v_dr;
        END LOOP;
    END LOOP;
    RETURN v_res;
END $$;

-- Bitboard of all pieces of one COLOR attacking square p_sq.
CREATE OR REPLACE FUNCTION chess_attackers(
    p_occ    bigint,
    p_pawn   bigint,
    p_knight bigint,
    p_bishop bigint,
    p_rook   bigint,
    p_queen  bigint,
    p_king   bigint,
    p_sq     int,
    p_white  boolean
)
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT (CASE WHEN p_white
                 THEN (CASE WHEN (p_sq & 7) < 7 AND p_sq >= 7
                            THEN p_pawn & (1::bigint << (p_sq - 7)) ELSE 0 END)
                    | (CASE WHEN (p_sq & 7) > 0 AND p_sq >= 9
                            THEN p_pawn & (1::bigint << (p_sq - 9)) ELSE 0 END)
                 ELSE (CASE WHEN (p_sq & 7) > 0 AND p_sq <= 56
                            THEN p_pawn & (1::bigint << (p_sq + 7)) ELSE 0 END)
                    | (CASE WHEN (p_sq & 7) < 7 AND p_sq <= 54
                            THEN p_pawn & (1::bigint << (p_sq + 9)) ELSE 0 END)
             END)
           | (chess_knight_att(p_sq) & p_knight)
           | (chess_king_att(p_sq)    & p_king)
           | (chess_slider_att(p_occ, p_sq, true)  & (p_bishop | p_queen))
           | (chess_slider_att(p_occ, p_sq, false) & (p_rook   | p_queen));
$$;

-- Main attack check (hot path). All right shifts of pawn bitboards go
-- through ::bit(64) so the sign bit 63 (square h8) never sign-extends.
CREATE OR REPLACE FUNCTION chess_sq_attacked_b(
    p_occ bigint, p_pawn bigint, p_knight bigint, p_bishop bigint,
    p_rook bigint, p_queen bigint, p_king bigint, p_sq int, p_white boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT ((1::bigint << p_sq) & (CASE WHEN p_white
                THEN (((p_pawn & x'FEFEFEFEFEFEFEFE'::bigint) << 7)
                    | ((p_pawn & x'7F7F7F7F7F7F7F7F'::bigint) << 9))
                ELSE ((((p_pawn & x'7F7F7F7F7F7F7F7F'::bigint)::bit(64)) >> 7)::bigint)
                    | ((((p_pawn & x'FEFEFEFEFEFEFEFE'::bigint)::bit(64)) >> 9)::bigint)
             END)) <> 0
        OR (chess_knight_att(p_sq) & p_knight) <> 0
        OR (chess_king_att(p_sq)    & p_king)    <> 0
        OR (chess_slider_att(p_occ, p_sq, true)  & (p_bishop | p_queen)) <> 0
        OR (chess_slider_att(p_occ, p_sq, false) & (p_rook   | p_queen)) <> 0;
$$;

CREATE OR REPLACE FUNCTION chess_is_square_attacked(p_b chess_board, p_sq int, p_by_white boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    v_occ bigint := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
                  |p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
BEGIN
    RETURN chess_sq_attacked_b(v_occ,
               CASE WHEN p_by_white THEN p_b.wp ELSE p_b.bp END,
               CASE WHEN p_by_white THEN p_b.wn ELSE p_b.bn END,
               CASE WHEN p_by_white THEN p_b.wb ELSE p_b.bb END,
               CASE WHEN p_by_white THEN p_b.wr ELSE p_b.br END,
               CASE WHEN p_by_white THEN p_b.wq ELSE p_b.bq END,
               CASE WHEN p_by_white THEN p_b.wk ELSE p_b.bk END,
               p_sq, p_by_white);
END $$;


-- 6. Make move. Castling rights and ep field semantics follow
--    chess.js _makeMove exactly.


CREATE OR REPLACE FUNCTION chess_make_move(p_b chess_board, p_from int, p_to int, p_promo text DEFAULT NULL)
RETURNS chess_board LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    v        chess_board := p_b;
    v_fb     bigint := 1::bigint << p_from;
    v_tb     bigint := 1::bigint << p_to;
    v_occ    bigint := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
                    |p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
    v_piece  int := 0;                        -- 1=P 2=N 3=B 4=R 5=Q 6=K
    v_white  boolean := p_b.white_to_move;
    v_cap    boolean;
    v_ep     boolean;
    v_promo  boolean;
    v_castle boolean;
    v_capt_sq int;
    v_rsrc   int;   -- castling: rook source
    v_rdst   int;   -- castling: rook target
    v_rbit   bigint;
BEGIN
    -- determine the moving piece type
    IF v_white THEN
        IF    (p_b.wp & v_fb) <> 0 THEN v_piece := 1;
        ELSIF (p_b.wn & v_fb) <> 0 THEN v_piece := 2;
        ELSIF (p_b.wb & v_fb) <> 0 THEN v_piece := 3;
        ELSIF (p_b.wr & v_fb) <> 0 THEN v_piece := 4;
        ELSIF (p_b.wq & v_fb) <> 0 THEN v_piece := 5;
        ELSIF (p_b.wk & v_fb) <> 0 THEN v_piece := 6;
        END IF;
    ELSE
        IF    (p_b.bp & v_fb) <> 0 THEN v_piece := 1;
        ELSIF (p_b.bn & v_fb) <> 0 THEN v_piece := 2;
        ELSIF (p_b.bb & v_fb) <> 0 THEN v_piece := 3;
        ELSIF (p_b.br & v_fb) <> 0 THEN v_piece := 4;
        ELSIF (p_b.bq & v_fb) <> 0 THEN v_piece := 5;
        ELSIF (p_b.bk & v_fb) <> 0 THEN v_piece := 6;
        END IF;
    END IF;
    IF v_piece = 0 THEN
        RAISE EXCEPTION 'make_move: на поле % нет фигуры ходящей стороны', chess_sq_name(p_from);
    END IF;

    v_cap    := (v_occ & v_tb) <> 0;
    v_ep     := v_piece = 1 AND p_b.ep >= 0 AND p_to = p_b.ep
                AND ((p_from & 7) <> (p_to & 7))
                AND abs((p_to >> 3) - (p_from >> 3)) = 1;
    v_promo  := v_piece = 1 AND ((p_to >> 3) IN (0, 7));
    v_castle := v_piece = 6 AND (p_to = p_from + 2 OR p_to = p_from - 2)
                AND ((p_to >> 3) = (p_from >> 3));

    -- 1) clear both the source and target square on all 12 boards (branchless)
    v.wp := v.wp & ~(v_fb | v_tb);  v.wn := v.wn & ~(v_fb | v_tb);
    v.wb := v.wb & ~(v_fb | v_tb);  v.wr := v.wr & ~(v_fb | v_tb);
    v.wq := v.wq & ~(v_fb | v_tb);  v.wk := v.wk & ~(v_fb | v_tb);
    v.bp := v.bp & ~(v_fb | v_tb);  v.bn := v.bn & ~(v_fb | v_tb);
    v.bb := v.bb & ~(v_fb | v_tb);  v.br := v.br & ~(v_fb | v_tb);
    v.bq := v.bq & ~(v_fb | v_tb);  v.bk := v.bk & ~(v_fb | v_tb);

    -- 2) en passant: remove whatever stands on the captured square
    --    (chess.js _clear() removes any piece; a malformed FEN could keep
    --    a non-pawn there, and occ must stay in sync with the boards)
    IF v_ep THEN
        v_capt_sq := p_to + (CASE WHEN v_white THEN -8 ELSE 8 END);
        v_rbit := 1::bigint << v_capt_sq;
        v.wp := v.wp & ~v_rbit;  v.wn := v.wn & ~v_rbit;
        v.wb := v.wb & ~v_rbit;  v.wr := v.wr & ~v_rbit;
        v.wq := v.wq & ~v_rbit;  v.wk := v.wk & ~v_rbit;
        v.bp := v.bp & ~v_rbit;  v.bn := v.bn & ~v_rbit;
        v.bb := v.bb & ~v_rbit;  v.br := v.br & ~v_rbit;
        v.bq := v.bq & ~v_rbit;  v.bk := v.bk & ~v_rbit;
    END IF;

    -- 3) place the piece on the target square (with promotion)
    IF v_white THEN
        IF v_promo THEN
            CASE lower(coalesce(p_promo, 'q'))
                WHEN 'q' THEN v.wq := v.wq | v_tb;
                WHEN 'r' THEN v.wr := v.wr | v_tb;
                WHEN 'b' THEN v.wb := v.wb | v_tb;
                WHEN 'n' THEN v.wn := v.wn | v_tb;
                ELSE RAISE EXCEPTION 'make_move: неверная фигура превращения "%"', p_promo;
            END CASE;
        ELSE
            CASE v_piece
                WHEN 1 THEN v.wp := v.wp | v_tb;
                WHEN 2 THEN v.wn := v.wn | v_tb;
                WHEN 3 THEN v.wb := v.wb | v_tb;
                WHEN 4 THEN v.wr := v.wr | v_tb;
                WHEN 5 THEN v.wq := v.wq | v_tb;
                WHEN 6 THEN v.wk := v.wk | v_tb;
            END CASE;
        END IF;
    ELSE
        IF v_promo THEN
            CASE lower(coalesce(p_promo, 'q'))
                WHEN 'q' THEN v.bq := v.bq | v_tb;
                WHEN 'r' THEN v.br := v.br | v_tb;
                WHEN 'b' THEN v.bb := v.bb | v_tb;
                WHEN 'n' THEN v.bn := v.bn | v_tb;
                ELSE RAISE EXCEPTION 'make_move: неверная фигура превращения "%"', p_promo;
            END CASE;
        ELSE
            CASE v_piece
                WHEN 1 THEN v.bp := v.bp | v_tb;
                WHEN 2 THEN v.bn := v.bn | v_tb;
                WHEN 3 THEN v.bb := v.bb | v_tb;
                WHEN 4 THEN v.br := v.br | v_tb;
                WHEN 5 THEN v.bq := v.bq | v_tb;
                WHEN 6 THEN v.bk := v.bk | v_tb;
            END CASE;
        END IF;
    END IF;

    -- 4) castling: move whatever stands on the rook path (chess.js
    --    _movePiece moves anything on castlingFrom; in legal play that is
    --    always the own rook). Source and target map to the UCI target.
    IF v_castle THEN
        CASE p_to
            WHEN p_from + 2 THEN v_rsrc := p_to + 1; v_rdst := p_to - 1;  -- 0-0
            ELSE                 v_rsrc := p_to - 2; v_rdst := p_to + 1;  -- 0-0-0
        END CASE;
        v_rbit := 1::bigint << v_rsrc;
        IF (v_occ & v_rbit) <> 0 THEN
            -- move any piece from v_rsrc to v_rdst
            IF    (v.wp & v_rbit) <> 0 THEN v.wp := (v.wp & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.wn & v_rbit) <> 0 THEN v.wn := (v.wn & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.wb & v_rbit) <> 0 THEN v.wb := (v.wb & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.wr & v_rbit) <> 0 THEN v.wr := (v.wr & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.wq & v_rbit) <> 0 THEN v.wq := (v.wq & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.wk & v_rbit) <> 0 THEN v.wk := (v.wk & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.bp & v_rbit) <> 0 THEN v.bp := (v.bp & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.bn & v_rbit) <> 0 THEN v.bn := (v.bn & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.bb & v_rbit) <> 0 THEN v.bb := (v.bb & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.br & v_rbit) <> 0 THEN v.br := (v.br & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.bq & v_rbit) <> 0 THEN v.bq := (v.bq & ~v_rbit) | (1::bigint << v_rdst);
            ELSIF (v.bk & v_rbit) <> 0 THEN v.bk := (v.bk & ~v_rbit) | (1::bigint << v_rdst);
            END IF;
        END IF;
    END IF;

    -- 5) castling rights, chess.js _makeMove semantics:
    --    (a) a king move drops all rights of that color
    IF v_piece = 6 THEN
        IF v_white THEN v.castling := v.castling & ~3; ELSE v.castling := v.castling & ~12; END IF;
    END IF;
    --    (b) a rook leaving its own corner drops that color's right
    IF v_piece = 4 THEN
        IF v_white THEN
            CASE p_from
                WHEN 0  THEN v.castling := v.castling & ~2;   -- a1: Q
                WHEN 7  THEN v.castling := v.castling & ~1;   -- h1: K
                ELSE NULL;
            END CASE;
        ELSE
            CASE p_from
                WHEN 56 THEN v.castling := v.castling & ~8;   -- a8: q
                WHEN 63 THEN v.castling := v.castling & ~4;   -- h8: k
                ELSE NULL;
            END CASE;
        END IF;
    END IF;
    --    (c) any move onto the enemy corner drops the enemy right, with no
    --        capture requirement (chess.js only checks move.to == ROOKS[them])
    IF v_white THEN
        CASE p_to
            WHEN 56 THEN v.castling := v.castling & ~8;       -- a8: q
            WHEN 63 THEN v.castling := v.castling & ~4;       -- h8: k
            ELSE NULL;
        END CASE;
    ELSE
        CASE p_to
            WHEN 0  THEN v.castling := v.castling & ~2;       -- a1: Q
            WHEN 7  THEN v.castling := v.castling & ~1;       -- h1: K
            ELSE NULL;
        END CASE;
    END IF;

    -- 6) ep field: only after a double pawn push and only when an enemy
    --    pawn stands nearby (chess.js _makeMove semantics)
    IF v_piece = 1 AND abs(p_to - p_from) = 16 THEN
        v.ep := CASE WHEN (v_white
                          AND ((   (p_to & 7) > 0 AND (v.bp & (1::bigint << (p_to - 1))) <> 0)
                            OR ((p_to & 7) < 7 AND (v.bp & (1::bigint << (p_to + 1))) <> 0)))
                     OR (NOT v_white
                          AND ((   (p_to & 7) > 0 AND (v.wp & (1::bigint << (p_to - 1))) <> 0)
                            OR ((p_to & 7) < 7 AND (v.wp & (1::bigint << (p_to + 1))) <> 0)))
                   THEN (p_from + p_to) / 2
                   ELSE -1 END;
    ELSE
        v.ep := -1;
    END IF;

    -- 7) counters and side switch
    v.halfmove := CASE WHEN v_piece = 1 OR v_cap THEN 0 ELSE p_b.halfmove + 1 END;
    v.fullmove := p_b.fullmove + (CASE WHEN v_white THEN 0 ELSE 1 END);
    v.white_to_move := NOT v_white;

    RETURN v;
END $$;


-- 7. Fast king safety check, without building a virtual board via a full
--    make_move:
--      * king   -> attack test on occupancy without the king (rays open correctly)
--      * ep     -> point mutation of occ and the enemy pawn bitboard
--      * others -> occ' = (occ \ from) | to, enemy boards untouched


CREATE OR REPLACE FUNCTION chess_move_safe(p_b chess_board, p_from int, p_to int)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    v_occ   bigint := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
                    |p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
    v_white boolean := p_b.white_to_move;
    v_fb    bigint := 1::bigint << p_from;
    v_tb    bigint := 1::bigint << p_to;
    v_ksq   int;
    v_is_king boolean;
    v_is_pawn boolean;
    v_is_ep   boolean;
    v_capt_sq int;
    v_capt_bb bigint;
    v_occ2  bigint;
    v_pawn  bigint;
    v_knight bigint;
    v_bishop bigint;
    v_rook  bigint;
    v_queen bigint;
    v_king  bigint;
BEGIN
    IF v_white THEN
        v_is_king := (p_b.wk & v_fb) <> 0;
        v_is_pawn := (p_b.wp & v_fb) <> 0;
        v_ksq := chess_bit_index(p_b.wk);
        -- attacking color boards = black
        v_pawn := p_b.bp; v_knight := p_b.bn; v_bishop := p_b.bb;
        v_rook := p_b.br; v_queen := p_b.bq; v_king := p_b.bk;
    ELSE
        v_is_king := (p_b.bk & v_fb) <> 0;
        v_is_pawn := (p_b.bp & v_fb) <> 0;
        v_ksq := chess_bit_index(p_b.bk);
        v_pawn := p_b.wp; v_knight := p_b.wn; v_bishop := p_b.wb;
        v_rook := p_b.wr; v_queen := p_b.wq; v_king := p_b.wk;
    END IF;

    v_is_ep := NOT v_is_king AND v_is_pawn
               AND p_b.ep >= 0 AND p_to = p_b.ep
               AND ((p_from & 7) <> (p_to & 7))
               AND abs((p_to >> 3) - (p_from >> 3)) = 1;

    IF NOT v_is_king THEN
        -- the captured piece must vanish from the enemy bitboards,
        -- otherwise capturing the checker would still read as check
        IF (v_occ & v_tb) <> 0 THEN
            IF v_white THEN
                IF    (v_tb & p_b.bp) <> 0 THEN v_pawn   := v_pawn   & ~v_tb;
                ELSIF (v_tb & p_b.bn) <> 0 THEN v_knight := v_knight & ~v_tb;
                ELSIF (v_tb & p_b.bb) <> 0 THEN v_bishop := v_bishop & ~v_tb;
                ELSIF (v_tb & p_b.br) <> 0 THEN v_rook   := v_rook   & ~v_tb;
                ELSIF (v_tb & p_b.bq) <> 0 THEN v_queen  := v_queen  & ~v_tb;
                END IF;
            ELSE
                IF    (v_tb & p_b.wp) <> 0 THEN v_pawn   := v_pawn   & ~v_tb;
                ELSIF (v_tb & p_b.wn) <> 0 THEN v_knight := v_knight & ~v_tb;
                ELSIF (v_tb & p_b.wb) <> 0 THEN v_bishop := v_bishop & ~v_tb;
                ELSIF (v_tb & p_b.wr) <> 0 THEN v_rook   := v_rook   & ~v_tb;
                ELSIF (v_tb & p_b.wq) <> 0 THEN v_queen  := v_queen  & ~v_tb;
                END IF;
            END IF;
        END IF;
    END IF;

    IF v_is_king THEN
        -- the king moves away: rays "through the king" open up
        RETURN NOT chess_sq_attacked_b(v_occ # v_fb,
                   v_pawn, v_knight, v_bishop, v_rook, v_queen, v_king,
                   p_to, NOT v_white);
    ELSIF v_is_ep THEN
        v_capt_sq := p_to + (CASE WHEN v_white THEN -8 ELSE 8 END);
        v_capt_bb := 1::bigint << v_capt_sq;
        v_occ2 := (v_occ & ~(v_fb | v_capt_bb)) | v_tb;
        -- remove whatever the enemy keeps on the captured square
        -- (chess.js _clear() removes any piece; occ must stay in sync)
        IF    (v_capt_bb & v_pawn)   <> 0 THEN v_pawn   := v_pawn   & ~v_capt_bb;
        ELSIF (v_capt_bb & v_knight) <> 0 THEN v_knight := v_knight & ~v_capt_bb;
        ELSIF (v_capt_bb & v_bishop) <> 0 THEN v_bishop := v_bishop & ~v_capt_bb;
        ELSIF (v_capt_bb & v_rook)   <> 0 THEN v_rook   := v_rook   & ~v_capt_bb;
        ELSIF (v_capt_bb & v_queen)  <> 0 THEN v_queen  := v_queen  & ~v_capt_bb;
        END IF;
        RETURN NOT chess_sq_attacked_b(v_occ2,
                   v_pawn, v_knight, v_bishop, v_rook, v_queen, v_king,
                   v_ksq, NOT v_white);
    ELSE
        v_occ2 := (v_occ & ~v_fb) | v_tb;
        RETURN NOT chess_sq_attacked_b(v_occ2,
                   v_pawn, v_knight, v_bishop, v_rook, v_queen, v_king,
                   v_ksq, NOT v_white);
    END IF;
END $$;


-- 8. Position analysis: checks (including double) and pins.


CREATE OR REPLACE FUNCTION chess_analyze_i(
    p_b chess_board, p_occ bigint, p_own bigint)
RETURNS chess_analysis LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v_white  boolean := p_b.white_to_move;
    v_occ    bigint := p_occ;
    v_ksq    int;
    v_own    bigint := p_own;
    v_ep     bigint;  v_en bigint;  v_eb bigint;  v_er bigint;  v_eq bigint;  v_ek bigint;
    v_checkers bigint;
    v_nchk   int;
    v_cmask  bigint := -1::bigint;
    v_pins   bigint := 0;
    v_rays   bigint[] := ARRAY[]::bigint[];
    v_d      constant int[] := ARRAY[1,1, 1,0, 1,-1, 0,-1, -1,-1, -1,0, -1,1, 0,1];
    v_i      int;
    v_df     int;
    v_dr     int;
    v_diag   boolean;
    v_nf     int;
    v_nr     int;
    v_s      int;
    v_bit    bigint;
    v_first  int;
    v_s2     int;
    v_seg    bigint;
    v_b2     bigint;
BEGIN
    -- Kingless board (reachable only from an input that captures the king,
    -- illegal by the rules but accepted by chess.js): no check, full check
    -- mask, no pins. Without this chess_bit_index(0)=64 produces garbage
    -- shifts and diverges from chess.js, which reports _isCheck()=false,
    -- no pins, and disables the legality filter.
    IF (CASE WHEN v_white THEN p_b.wk ELSE p_b.bk END) = 0 THEN
        RETURN (0::bigint, -1::bigint, 0::bigint, ARRAY[]::bigint[])::chess_analysis;
    END IF;

    IF v_white THEN
        v_ksq := chess_bit_index(p_b.wk);
        v_own := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk;
        v_ep := p_b.bp; v_en := p_b.bn; v_eb := p_b.bb;
        v_er := p_b.br; v_eq := p_b.bq; v_ek := p_b.bk;
    ELSE
        v_ksq := chess_bit_index(p_b.bk);
        v_own := p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
        v_ep := p_b.wp; v_en := p_b.wn; v_eb := p_b.wb;
        v_er := p_b.wr; v_eq := p_b.wq; v_ek := p_b.wk;
    END IF;

    v_checkers := chess_attackers(v_occ, v_ep, v_en, v_eb, v_er, v_eq, v_ek,
                                  v_ksq, NOT v_white);
    v_nchk := chess_popcount(v_checkers);

    IF v_nchk = 1 THEN
        v_s := chess_bit_index(v_checkers);
        v_bit := 1::bigint << v_s;
        IF (v_bit & (v_eb | v_er | v_eq)) <> 0 THEN
            v_df  := sign((v_s & 7) - (v_ksq & 7));
            v_dr  := sign((v_s >> 3) - (v_ksq >> 3));
            v_seg := 0::bigint;
            v_nf  := (v_ksq & 7) + v_df;
            v_nr  := (v_ksq >> 3) + v_dr;
            LOOP
                v_s2  := v_nr*8 + v_nf;
                v_seg := v_seg | (1::bigint << v_s2);
                EXIT WHEN v_s2 = v_s;
                v_nf := v_nf + v_df;
                v_nr := v_nr + v_dr;
            END LOOP;
            v_cmask := v_seg;
        ELSE
            v_cmask := v_bit;
        END IF;
    ELSIF v_nchk > 1 THEN
        v_cmask := 0;           -- double check
    END IF;

    -- pins: the first two blockers on each of the 8 rays
    IF (v_eb | v_er | v_eq) <> 0 THEN
    FOR v_i IN 0..7 LOOP
        v_df   := v_d[v_i*2 + 1];
        v_dr   := v_d[v_i*2 + 2];
        v_diag := (v_df <> 0 AND v_dr <> 0);
        v_nf   := (v_ksq & 7) + v_df;
        v_nr   := (v_ksq >> 3) + v_dr;
        v_first := -1;
        v_s2    := -1;
        v_seg   := 0::bigint;
        WHILE v_nf BETWEEN 0 AND 7 AND v_nr BETWEEN 0 AND 7 LOOP
            v_s    := v_nr*8 + v_nf;
            v_bit  := 1::bigint << v_s;
            v_seg  := v_seg | v_bit;
            IF (v_occ & v_bit) <> 0 THEN
                IF v_first = -1 THEN
                    v_first := v_s;
                ELSE
                    v_s2 := v_s;
                    EXIT;
                END IF;
            END IF;
            v_nf := v_nf + v_df;
            v_nr := v_nr + v_dr;
        END LOOP;

        IF v_s2 >= 0
           AND ((1::bigint << v_first) & v_own) <> 0 THEN
            v_b2 := 1::bigint << v_s2;
            IF ((v_b2 & (CASE WHEN v_diag THEN (v_eb | v_eq) ELSE (v_er | v_eq) END)) <> 0) THEN
                v_pins := v_pins | (1::bigint << v_first);
                v_rays[v_first + 1] := v_seg;
            END IF;
        END IF;
    END LOOP;
    END IF;

    RETURN (v_checkers, v_cmask, v_pins, v_rays)::chess_analysis;
END $$;

CREATE OR REPLACE FUNCTION chess_analyze(p_b chess_board)
RETURNS chess_analysis LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v_occ bigint := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
                  |p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
    v_own bigint := CASE WHEN p_b.white_to_move
                         THEN p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
                         ELSE p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk END;
BEGIN
    RETURN chess_analyze_i(p_b, v_occ, v_own);
END $$;


-- 9. Full legal move generation. Optimized scheme:
--      * pawns run as bulk bitboard operations (pushes, captures, and
--        promotions in single shifts); only pinned pawns go individually;
--        en passant is one block;
--      * the enemy attack map is built once on occupancy without the king
--        and filters every king target and castling transit square;
--      * castling is judged relative to the current king square (like
--        chess.js, without checking rook presence);
--      * moves accumulate via index assignment (expanded array, O(1));
--      * p_first_only = true exits after the first legal move, to test
--        whether any reply exists (checkmate/stalemate in play_move);
--        all checkpoints sit after blocks that emit only legal moves,
--        so a partial result matches the full one on "list is empty".


DROP FUNCTION IF EXISTS chess_get_moves_b(chess_board);

CREATE OR REPLACE FUNCTION chess_get_moves_b(p_b chess_board,
                                             p_first_only boolean DEFAULT false)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v_white  boolean := p_b.white_to_move;
    v_occ    bigint := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
                     |p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
    v_own    bigint;
    v_enemy  bigint;
    v_ksq    int;
    v_an     chess_analysis;
    v_nchk   int;
    v_cmask  bigint;
    v_pins   bigint;
    v_rays   bigint[];
    v_res    text[] := ARRAY[]::text[];
    v_n      int := 0;    -- accumulated move counter (index assignment)
    v_bb     bigint;
    v_from   int;
    v_to     int;
    v_mask   bigint;
    v_tg     bigint;
    v_tg2    bigint;
    v_tbit   bigint;
    v_t1     int;
    v_t2     int;
    v_fname  text;
    v_pt     int;
    -- enemy attack map
    v_kocc     bigint;
    v_atk      bigint;
    v_e_ksq    int;
    v_e_pawn   bigint;
    v_e_knight bigint;
    v_e_bishop bigint;
    v_e_rook   bigint;
    v_e_queen  bigint;
BEGIN
    IF v_white THEN
        v_own   := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk;
        v_enemy := p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
    ELSE
        v_own   := p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;
        v_enemy := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk;
    END IF;
    v_ksq  := chess_bit_index(CASE WHEN v_white THEN p_b.wk ELSE p_b.bk END);
    v_an   := chess_analyze_i(p_b, v_occ, v_own);
    v_nchk := chess_popcount(v_an.checkers);
    v_cmask := v_an.checkmask;
    v_pins  := v_an.pins;
    v_rays  := v_an.pinrays;

    IF v_nchk < 2 THEN
        -- PAWNS (bulk) 
        v_bb   := CASE WHEN v_white THEN p_b.wp ELSE p_b.bp END;
        v_tg   := v_bb & ~v_pins;                    -- unpinned pawns

        IF v_white THEN
            -- single pushes: targets = (pawns << 8) & empty & check mask
            v_tg2 := (v_tg << 8) & ~v_occ & v_cmask;
            -- non-promotion targets (bits 0..55)
            v_mask := v_tg2 & x'00FFFFFFFFFFFFFF'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to - 8) || chess_sq_name(v_to);
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            -- promotions (bits 56..63)
            v_mask := v_tg2 & x'FF00000000000000'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_fname := chess_sq_name(v_to - 8) || chess_sq_name(v_to);
                v_n := v_n + 1; v_res[v_n] := v_fname || 'q';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'r';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'b';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'n';
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            -- double pushes from rank 2: both squares empty, target in mask
            v_tg2 := (((v_tg << 8) & ~v_occ) << 8) & ~v_occ & v_cmask
                     & x'00000000FF000000'::bigint;
            WHILE v_tg2 <> 0 LOOP
                v_to := chess_lsb_index(v_tg2);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to - 16) || chess_sq_name(v_to);
                v_tg2 := v_tg2 & ~(1::bigint << v_to);
            END LOOP;
            -- captures up-left (from file > 0): to = from + 7
            v_tg2 := ((v_tg & x'FEFEFEFEFEFEFEFE'::bigint) << 7) & v_enemy & v_cmask;
            v_mask := v_tg2 & x'00FFFFFFFFFFFFFF'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to - 7) || chess_sq_name(v_to);
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            v_mask := v_tg2 & x'FF00000000000000'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_fname := chess_sq_name(v_to - 7) || chess_sq_name(v_to);
                v_n := v_n + 1; v_res[v_n] := v_fname || 'q';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'r';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'b';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'n';
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            -- captures up-right (from file < 7): to = from + 9
            v_tg2 := ((v_tg & x'7F7F7F7F7F7F7F7F'::bigint) << 9) & v_enemy & v_cmask;
            v_mask := v_tg2 & x'00FFFFFFFFFFFFFF'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to - 9) || chess_sq_name(v_to);
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            v_mask := v_tg2 & x'FF00000000000000'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_fname := chess_sq_name(v_to - 9) || chess_sq_name(v_to);
                v_n := v_n + 1; v_res[v_n] := v_fname || 'q';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'r';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'b';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'n';
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
        ELSE
            -- black pawns (downward shifts via ::bit(64))
            v_tg2 := (((v_tg::bit(64)) >> 8)::bigint) & ~v_occ & v_cmask;
            v_mask := v_tg2 & x'FFFFFFFFFFFFFF00'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to + 8) || chess_sq_name(v_to);
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            v_mask := v_tg2 & x'00000000000000FF'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_fname := chess_sq_name(v_to + 8) || chess_sq_name(v_to);
                v_n := v_n + 1; v_res[v_n] := v_fname || 'q';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'r';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'b';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'n';
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            -- double pushes from rank 7
            v_tg2 := (((((v_tg::bit(64)) >> 8)::bigint) & ~v_occ)::bit(64) >> 8)::bigint
                     & ~v_occ & v_cmask & x'000000FF00000000'::bigint;
            WHILE v_tg2 <> 0 LOOP
                v_to := chess_lsb_index(v_tg2);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to + 16) || chess_sq_name(v_to);
                v_tg2 := v_tg2 & ~(1::bigint << v_to);
            END LOOP;
            -- captures down-left (from file > 0): to = from - 9
            v_tg2 := ((((v_tg & x'FEFEFEFEFEFEFEFE'::bigint)::bit(64)) >> 9)::bigint)
                     & v_enemy & v_cmask;
            v_mask := v_tg2 & x'FFFFFFFFFFFFFF00'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to + 9) || chess_sq_name(v_to);
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            v_mask := v_tg2 & x'00000000000000FF'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_fname := chess_sq_name(v_to + 9) || chess_sq_name(v_to);
                v_n := v_n + 1; v_res[v_n] := v_fname || 'q';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'r';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'b';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'n';
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            -- captures down-right (from file < 7): to = from - 7
            v_tg2 := ((((v_tg & x'7F7F7F7F7F7F7F7F'::bigint)::bit(64)) >> 7)::bigint)
                     & v_enemy & v_cmask;
            v_mask := v_tg2 & x'FFFFFFFFFFFFFF00'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_n := v_n + 1;
                v_res[v_n] := chess_sq_name(v_to + 7) || chess_sq_name(v_to);
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
            v_mask := v_tg2 & x'00000000000000FF'::bigint;
            WHILE v_mask <> 0 LOOP
                v_to := chess_lsb_index(v_mask);
                v_fname := chess_sq_name(v_to + 7) || chess_sq_name(v_to);
                v_n := v_n + 1; v_res[v_n] := v_fname || 'q';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'r';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'b';
                v_n := v_n + 1; v_res[v_n] := v_fname || 'n';
                v_mask := v_mask & ~(1::bigint << v_to);
            END LOOP;
        END IF;

        -- early exit: unpinned pawns already produced a legal move
        IF p_first_only AND v_n > 0 THEN
            RETURN v_res;
        END IF;

        -- PINNED PAWNS (individual) 
        v_bb := CASE WHEN v_white THEN p_b.wp ELSE p_b.bp END;
        v_bb := v_bb & v_pins;
        WHILE v_bb <> 0 LOOP
            v_from  := chess_lsb_index(v_bb);
            v_bb    := v_bb & ~(1::bigint << v_from);
            v_fname := chess_sq_name(v_from);
            v_mask  := v_cmask & coalesce(v_rays[v_from + 1], -1::bigint);
            IF v_white THEN
                v_t1 := v_from + 8;
                IF (v_occ & (1::bigint << v_t1)) = 0 THEN
                    IF ((1::bigint << v_t1) & v_mask) <> 0 THEN
                        IF v_t1 >= 56 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'q';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'r';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'b';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'n';
                        ELSE
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1);
                        END IF;
                    END IF;
                    IF v_from < 16 THEN
                        v_t2 := v_from + 16;
                        IF (v_occ & (1::bigint << v_t2)) = 0
                           AND ((1::bigint << v_t2) & v_mask) <> 0 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t2);
                        END IF;
                    END IF;
                END IF;
                IF (v_from & 7) > 0 THEN
                    v_t1 := v_from + 7;
                    IF (v_enemy & (1::bigint << v_t1)) <> 0
                       AND ((1::bigint << v_t1) & v_mask) <> 0 THEN
                        IF v_t1 >= 56 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'q';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'r';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'b';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'n';
                        ELSE
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1);
                        END IF;
                    END IF;
                END IF;
                IF (v_from & 7) < 7 THEN
                    v_t1 := v_from + 9;
                    IF (v_enemy & (1::bigint << v_t1)) <> 0
                       AND ((1::bigint << v_t1) & v_mask) <> 0 THEN
                        IF v_t1 >= 56 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'q';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'r';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'b';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'n';
                        ELSE
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1);
                        END IF;
                    END IF;
                END IF;
            ELSE
                v_t1 := v_from - 8;
                IF (v_occ & (1::bigint << v_t1)) = 0 THEN
                    IF ((1::bigint << v_t1) & v_mask) <> 0 THEN
                        IF v_t1 <= 7 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'q';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'r';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'b';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'n';
                        ELSE
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1);
                        END IF;
                    END IF;
                    IF v_from >= 48 THEN
                        v_t2 := v_from - 16;
                        IF (v_occ & (1::bigint << v_t2)) = 0
                           AND ((1::bigint << v_t2) & v_mask) <> 0 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t2);
                        END IF;
                    END IF;
                END IF;
                IF (v_from & 7) > 0 THEN
                    v_t1 := v_from - 9;
                    IF (v_enemy & (1::bigint << v_t1)) <> 0
                       AND ((1::bigint << v_t1) & v_mask) <> 0 THEN
                        IF v_t1 <= 7 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'q';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'r';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'b';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'n';
                        ELSE
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1);
                        END IF;
                    END IF;
                END IF;
                IF (v_from & 7) < 7 THEN
                    v_t1 := v_from - 7;
                    IF (v_enemy & (1::bigint << v_t1)) <> 0
                       AND ((1::bigint << v_t1) & v_mask) <> 0 THEN
                        IF v_t1 <= 7 THEN
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'q';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'r';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'b';
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1) || 'n';
                        ELSE
                            v_n := v_n + 1; v_res[v_n] := v_fname || chess_sq_name(v_t1);
                        END IF;
                    END IF;
                END IF;
            END IF;
        END LOOP;

        -- early exit: pinned pawns produced a legal move
        IF p_first_only AND v_n > 0 THEN
            RETURN v_res;
        END IF;

        -- EN PASSANT (one block per position)
        -- No check/pin masks here: chess_move_safe decides legality
        -- (it covers both horizontal discoveries and ep while in check).
        -- If the ep square holds an ENEMY piece (malformed FEN) the move was
        -- already generated by bulk captures; no repeat is needed (chess.js:
        -- "if (board[to].color === them) ... else if (to === _epSquare)").
        IF p_b.ep >= 0 AND (v_enemy & (1::bigint << p_b.ep)) = 0 THEN
            IF (p_b.ep & 7) > 0 THEN
                -- white from ep-9 (file-1); black from ep+7 (file-1)
                v_t1 := p_b.ep + (CASE WHEN v_white THEN -9 ELSE 7 END);
                IF (CASE WHEN v_white THEN p_b.wp ELSE p_b.bp END & (1::bigint << v_t1)) <> 0
                   AND chess_move_safe(p_b, v_t1, p_b.ep) THEN
                    v_n := v_n + 1;
                    v_res[v_n] := chess_sq_name(v_t1) || chess_sq_name(p_b.ep);
                END IF;
            END IF;
            IF (p_b.ep & 7) < 7 THEN
                -- white from ep-7 (file+1); black from ep+9 (file+1)
                v_t1 := p_b.ep + (CASE WHEN v_white THEN -7 ELSE 9 END);
                IF (CASE WHEN v_white THEN p_b.wp ELSE p_b.bp END & (1::bigint << v_t1)) <> 0
                   AND chess_move_safe(p_b, v_t1, p_b.ep) THEN
                    v_n := v_n + 1;
                    v_res[v_n] := chess_sq_name(v_t1) || chess_sq_name(p_b.ep);
                END IF;
            END IF;
        END IF;

        -- early exit: en passant produced a legal move
        IF p_first_only AND v_n > 0 THEN
            RETURN v_res;
        END IF;

        -- KNIGHTS 
        v_bb := CASE WHEN v_white THEN p_b.wn ELSE p_b.bn END;
        WHILE v_bb <> 0 LOOP
            v_from  := chess_lsb_index(v_bb);
            v_bb    := v_bb & ~(1::bigint << v_from);
            v_fname := chess_sq_name(v_from);
            IF ((1::bigint << v_from) & v_pins) <> 0 THEN
                v_mask := 0::bigint;      -- a pinned knight cannot move
            ELSE
                v_mask := v_cmask;
            END IF;
            v_tg := chess_knight_att(v_from) & ~v_own & v_mask;
            WHILE v_tg <> 0 LOOP
                v_to   := chess_lsb_index(v_tg);
                v_tbit := 1::bigint << v_to;
                v_tg   := v_tg - v_tbit;
                v_n := v_n + 1;
                v_res[v_n] := v_fname || chess_sq_name(v_to);
            END LOOP;
        END LOOP;

        -- early exit: knights produced a legal move
        IF p_first_only AND v_n > 0 THEN
            RETURN v_res;
        END IF;

        -- BISHOPS / ROOKS / QUEENS 
        FOR v_pt IN 1..3 LOOP
            v_bb := CASE v_pt
                        WHEN 1 THEN CASE WHEN v_white THEN p_b.wb ELSE p_b.bb END
                        WHEN 2 THEN CASE WHEN v_white THEN p_b.wr ELSE p_b.br END
                        ELSE        CASE WHEN v_white THEN p_b.wq ELSE p_b.bq END
                    END;
            WHILE v_bb <> 0 LOOP
                v_from  := chess_lsb_index(v_bb);
                v_bb    := v_bb & ~(1::bigint << v_from);
                v_fname := chess_sq_name(v_from);
                v_mask := v_cmask;
                IF ((1::bigint << v_from) & v_pins) <> 0 THEN
                    v_mask := v_mask & coalesce(v_rays[v_from + 1], -1::bigint);
                END IF;
                v_tg := CASE v_pt
                            WHEN 1 THEN chess_slider_att(v_occ, v_from, true)
                            WHEN 2 THEN chess_slider_att(v_occ, v_from, false)
                            ELSE chess_slider_att(v_occ, v_from, true)
                              | chess_slider_att(v_occ, v_from, false)
                        END;
                v_tg := v_tg & ~v_own & v_mask;
                WHILE v_tg <> 0 LOOP
                    v_to   := chess_lsb_index(v_tg);
                    v_tbit := 1::bigint << v_to;
                    v_tg   := v_tg - v_tbit;
                    v_n := v_n + 1;
                    v_res[v_n] := v_fname || chess_sq_name(v_to);
                END LOOP;
            END LOOP;
        END LOOP;

        -- early exit: bishops/rooks/queens produced a legal move; otherwise
        -- build the attack map and check king/castling (always last)
        IF p_first_only AND v_n > 0 THEN
            RETURN v_res;
        END IF;
    END IF; -- end of non-king moves when not in double check

    -- ENEMY ATTACK MAP 
    -- Kingless board: chess.js builds no attack map and generates neither
    -- king moves nor castling; remaining pieces move freely (the legality
    -- filter dies with the king). Early exit avoids wrong rays from an
    -- attack map built on v_kocc with garbage v_ksq=64.
    IF (CASE WHEN v_white THEN p_b.wk ELSE p_b.bk END) = 0 THEN
        RETURN v_res;
    END IF;

    -- Built on occupancy WITHOUT our king: rays "through the king" open up,
    -- which is correct for filtering king targets. For castling transit
    -- squares this equals full occupancy when not in check (a ray through
    -- the king would mean check anyway).
    v_kocc := v_occ # (1::bigint << v_ksq);
    IF v_white THEN
        v_e_ksq   := chess_bit_index(p_b.bk);
        v_e_pawn  := p_b.bp; v_e_knight := p_b.bn; v_e_bishop := p_b.bb;
        v_e_rook  := p_b.br; v_e_queen  := p_b.bq;
        v_atk := ((((p_b.bp & x'7F7F7F7F7F7F7F7F'::bigint)::bit(64)) >> 7)::bigint)
               | ((((p_b.bp & x'FEFEFEFEFEFEFEFE'::bigint)::bit(64)) >> 9)::bigint);
    ELSE
        v_e_ksq   := chess_bit_index(p_b.wk);
        v_e_pawn  := p_b.wp; v_e_knight := p_b.wn; v_e_bishop := p_b.wb;
        v_e_rook  := p_b.wr; v_e_queen  := p_b.wq;
        v_atk := ((p_b.wp & x'FEFEFEFEFEFEFEFE'::bigint) << 7)
               | ((p_b.wp & x'7F7F7F7F7F7F7F7F'::bigint) << 9);
    END IF;
    v_atk := v_atk | chess_king_att(v_e_ksq);
    v_bb := v_e_knight;
    WHILE v_bb <> 0 LOOP
        v_from := chess_lsb_index(v_bb);
        v_bb   := v_bb & ~(1::bigint << v_from);
        v_atk  := v_atk | chess_knight_att(v_from);
    END LOOP;
    v_bb := v_e_bishop;
    WHILE v_bb <> 0 LOOP
        v_from := chess_lsb_index(v_bb);
        v_bb   := v_bb & ~(1::bigint << v_from);
        v_atk  := v_atk | chess_slider_att(v_kocc, v_from, true);
    END LOOP;
    v_bb := v_e_rook;
    WHILE v_bb <> 0 LOOP
        v_from := chess_lsb_index(v_bb);
        v_bb   := v_bb & ~(1::bigint << v_from);
        v_atk  := v_atk | chess_slider_att(v_kocc, v_from, false);
    END LOOP;
    v_bb := v_e_queen;
    WHILE v_bb <> 0 LOOP
        v_from := chess_lsb_index(v_bb);
        v_bb   := v_bb & ~(1::bigint << v_from);
        v_atk  := v_atk | chess_slider_att(v_kocc, v_from, true)
                        | chess_slider_att(v_kocc, v_from, false);
    END LOOP;

    -- KING (always, even under double check) 
    v_fname := chess_sq_name(v_ksq);
    v_tg := chess_king_att(v_ksq) & ~v_own & ~v_atk;
    WHILE v_tg <> 0 LOOP
        v_to   := chess_lsb_index(v_tg);
        v_tbit := 1::bigint << v_to;
        v_tg   := v_tg - v_tbit;
        v_n := v_n + 1;
        v_res[v_n] := v_fname || chess_sq_name(v_to);
    END LOOP;

    -- CASTLING (king not in check)
    -- Relative to the CURRENT king square; the rook is NOT validated
    -- (chess.js does not either); transit squares use the attack map.
    IF v_nchk = 0 THEN
        IF v_white THEN
            IF (p_b.castling & 1) <> 0 AND (v_ksq & 7) <= 5 THEN
                v_tg := (1::bigint << (v_ksq + 1)) | (1::bigint << (v_ksq + 2));
                IF (v_occ & v_tg) = 0 AND (v_atk & v_tg) = 0 THEN
                    v_n := v_n + 1;
                    v_res[v_n] := chess_sq_name(v_ksq) || chess_sq_name(v_ksq + 2);
                END IF;
            END IF;
            IF (p_b.castling & 2) <> 0 AND (v_ksq & 7) >= 2 THEN
                v_tg := (1::bigint << (v_ksq - 1)) | (1::bigint << (v_ksq - 2));
                IF (v_occ & v_tg) = 0 AND (v_atk & v_tg) = 0
                   AND ((v_ksq & 7) < 3 OR (v_occ & (1::bigint << (v_ksq - 3))) = 0) THEN
                    v_n := v_n + 1;
                    v_res[v_n] := chess_sq_name(v_ksq) || chess_sq_name(v_ksq - 2);
                END IF;
            END IF;
        ELSE
            IF (p_b.castling & 4) <> 0 AND (v_ksq & 7) <= 5 THEN
                v_tg := (1::bigint << (v_ksq + 1)) | (1::bigint << (v_ksq + 2));
                IF (v_occ & v_tg) = 0 AND (v_atk & v_tg) = 0 THEN
                    v_n := v_n + 1;
                    v_res[v_n] := chess_sq_name(v_ksq) || chess_sq_name(v_ksq + 2);
                END IF;
            END IF;
            IF (p_b.castling & 8) <> 0 AND (v_ksq & 7) >= 2 THEN
                v_tg := (1::bigint << (v_ksq - 1)) | (1::bigint << (v_ksq - 2));
                IF (v_occ & v_tg) = 0 AND (v_atk & v_tg) = 0
                   AND ((v_ksq & 7) < 3 OR (v_occ & (1::bigint << (v_ksq - 3))) = 0) THEN
                    v_n := v_n + 1;
                    v_res[v_n] := chess_sq_name(v_ksq) || chess_sq_name(v_ksq - 2);
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN v_res;
END $$;

-- Public wrapper: FEN to all legal moves (UCI with promotion suffixes).
CREATE OR REPLACE FUNCTION chess_get_moves(p_fen text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
    IF p_fen IS NULL THEN
        RAISE EXCEPTION 'chess_get_moves: FEN не может быть NULL';
    END IF;
    RETURN chess_get_moves_b(chess_parse_fen(p_fen));
END $$;


-- 10. Inline legality check for a single move.
--     Castling is recognized relative to the current king square
--     (to = from +/- 2 on the same rank), matching chess.js. The terminal
--     chess_move_safe test covers every check case. The core
--     chess_validate_move_b works on an already-parsed board: the public
--     chess_validate_move and chess_play_move parse FEN exactly once.


CREATE OR REPLACE FUNCTION chess_validate_move_b(p_b chess_board, p_move text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    v_b      chess_board := p_b;
    v_white  boolean;
    v_from   int;
    v_to     int;
    v_promo  text;
    v_fb     bigint;
    v_tb     bigint;
    v_occ    bigint;
    v_own    bigint;
    v_enemy  bigint;
    v_piece  int := 0;
    v_tg     bigint;
    v_t1     int;
    v_is_ep  boolean;
    v_capt_sq int;
    v_file   int;
BEGIN
    IF p_b IS NULL OR p_move IS NULL THEN
        RETURN false;
    END IF;
    -- strict UCI: e2e4, e7e8q, e1g1 ...
    IF p_move !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' THEN
        RETURN false;
    END IF;

    v_white := v_b.white_to_move;
    v_from  := chess_sq_from_name(substr(p_move, 1, 2));
    v_to    := chess_sq_from_name(substr(p_move, 3, 2));
    v_promo := CASE WHEN length(p_move) = 5 THEN substr(p_move, 5, 1) END;
    v_fb    := 1::bigint << v_from;
    v_tb    := 1::bigint << v_to;
    v_occ   := v_b.wp|v_b.wn|v_b.wb|v_b.wr|v_b.wq|v_b.wk
            |v_b.bp|v_b.bn|v_b.bb|v_b.br|v_b.bq|v_b.bk;
    IF v_white THEN
        v_own   := v_b.wp|v_b.wn|v_b.wb|v_b.wr|v_b.wq|v_b.wk;
        v_enemy := v_b.bp|v_b.bn|v_b.bb|v_b.br|v_b.bq|v_b.bk;
    ELSE
        v_own   := v_b.bp|v_b.bn|v_b.bb|v_b.br|v_b.bq|v_b.bk;
        v_enemy := v_b.wp|v_b.wn|v_b.wb|v_b.wr|v_b.wq|v_b.wk;
    END IF;

    -- the source square holds a piece of the side to move and the target is not own-occupied
    IF (v_own & v_fb) = 0 OR (v_own & v_tb) <> 0 THEN
        RETURN false;
    END IF;

    -- determine the piece type
    IF v_white THEN
        IF    (v_b.wp & v_fb) <> 0 THEN v_piece := 1;
        ELSIF (v_b.wn & v_fb) <> 0 THEN v_piece := 2;
        ELSIF (v_b.wb & v_fb) <> 0 THEN v_piece := 3;
        ELSIF (v_b.wr & v_fb) <> 0 THEN v_piece := 4;
        ELSIF (v_b.wq & v_fb) <> 0 THEN v_piece := 5;
        ELSE                            v_piece := 6;
        END IF;
    ELSE
        IF    (v_b.bp & v_fb) <> 0 THEN v_piece := 1;
        ELSIF (v_b.bn & v_fb) <> 0 THEN v_piece := 2;
        ELSIF (v_b.bb & v_fb) <> 0 THEN v_piece := 3;
        ELSIF (v_b.br & v_fb) <> 0 THEN v_piece := 4;
        ELSIF (v_b.bq & v_fb) <> 0 THEN v_piece := 5;
        ELSE                            v_piece := 6;
        END IF;
    END IF;

    -- a promotion suffix is allowed for pawns only
    IF v_piece <> 1 AND v_promo IS NOT NULL THEN
        RETURN false;
    END IF;

    -- KING 
    IF v_piece = 6 THEN
        -- castling: to = from +/- 2 on the SAME rank (chess.js: castlingTo =
        -- castlingFrom +/- 2); the king may stand anywhere and the rook is
        -- not validated. Attacks are checked directly via chess_sq_attacked_b
        -- with the already-computed v_occ and enemy bitboards.
        v_file := v_from & 7;
        IF (v_to >> 3) = (v_from >> 3) AND abs(v_file - (v_to & 7)) = 2 THEN
            IF v_white THEN
                IF v_to = v_from + 2 THEN          -- 0-0
                    IF v_file > 5 THEN RETURN false; END IF;   -- garbage kings are not reproduced
                    RETURN (v_b.castling & 1) <> 0
                       AND (v_occ & ((1::bigint << (v_from + 1)) | v_tb)) = 0
                       AND NOT chess_sq_attacked_b(v_occ, v_b.bp, v_b.bn, v_b.bb,
                                                   v_b.br, v_b.bq, v_b.bk,
                                                   v_from, false)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.bp, v_b.bn, v_b.bb,
                                                   v_b.br, v_b.bq, v_b.bk,
                                                   v_from + 1, false)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.bp, v_b.bn, v_b.bb,
                                                   v_b.br, v_b.bq, v_b.bk,
                                                   v_to, false);
                ELSIF v_to = v_from - 2 THEN       -- 0-0-0
                    IF v_file < 2 THEN RETURN false; END IF;
                    RETURN (v_b.castling & 2) <> 0
                       AND (v_occ & ((1::bigint << (v_from - 1)) | (1::bigint << (v_from - 2)))) = 0
                       AND (v_file < 3 OR (v_occ & (1::bigint << (v_from - 3))) = 0)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.bp, v_b.bn, v_b.bb,
                                                   v_b.br, v_b.bq, v_b.bk,
                                                   v_from, false)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.bp, v_b.bn, v_b.bb,
                                                   v_b.br, v_b.bq, v_b.bk,
                                                   v_from - 1, false)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.bp, v_b.bn, v_b.bb,
                                                   v_b.br, v_b.bq, v_b.bk,
                                                   v_to, false);
                ELSE
                    RETURN false;
                END IF;
            ELSE
                IF v_to = v_from + 2 THEN
                    IF v_file > 5 THEN RETURN false; END IF;
                    RETURN (v_b.castling & 4) <> 0
                       AND (v_occ & ((1::bigint << (v_from + 1)) | v_tb)) = 0
                       AND NOT chess_sq_attacked_b(v_occ, v_b.wp, v_b.wn, v_b.wb,
                                                   v_b.wr, v_b.wq, v_b.wk,
                                                   v_from, true)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.wp, v_b.wn, v_b.wb,
                                                   v_b.wr, v_b.wq, v_b.wk,
                                                   v_from + 1, true)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.wp, v_b.wn, v_b.wb,
                                                   v_b.wr, v_b.wq, v_b.wk,
                                                   v_to, true);
                ELSIF v_to = v_from - 2 THEN
                    IF v_file < 2 THEN RETURN false; END IF;
                    RETURN (v_b.castling & 8) <> 0
                       AND (v_occ & ((1::bigint << (v_from - 1)) | (1::bigint << (v_from - 2)))) = 0
                       AND (v_file < 3 OR (v_occ & (1::bigint << (v_from - 3))) = 0)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.wp, v_b.wn, v_b.wb,
                                                   v_b.wr, v_b.wq, v_b.wk,
                                                   v_from, true)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.wp, v_b.wn, v_b.wb,
                                                   v_b.wr, v_b.wq, v_b.wk,
                                                   v_from - 1, true)
                       AND NOT chess_sq_attacked_b(v_occ, v_b.wp, v_b.wn, v_b.wb,
                                                   v_b.wr, v_b.wq, v_b.wk,
                                                   v_to, true);
                ELSE
                    RETURN false;
                END IF;
            END IF;
        END IF;
        -- a normal king move must be to an adjacent square
        IF (chess_king_att(v_from) & v_tb) = 0 THEN
            RETURN false;
        END IF;
        -- king leaves: attack test on occupancy without the source square
        IF v_white THEN
            RETURN NOT chess_sq_attacked_b(v_occ # (1::bigint << v_from),
                       v_b.bp, v_b.bn, v_b.bb, v_b.br, v_b.bq, v_b.bk, v_to, false);
        END IF;
        RETURN NOT chess_sq_attacked_b(v_occ # (1::bigint << v_from),
                   v_b.wp, v_b.wn, v_b.wb, v_b.wr, v_b.wq, v_b.wk, v_to, true);
    END IF;

    -- PAWN 
    IF v_piece = 1 THEN
        v_tg := 0::bigint;
        IF v_white THEN
            IF (v_occ & (1::bigint << (v_from + 8))) = 0 THEN
                v_tg := v_tg | (1::bigint << (v_from + 8));
                IF v_from < 16 AND (v_occ & (1::bigint << (v_from + 16))) = 0 THEN
                    v_tg := v_tg | (1::bigint << (v_from + 16));
                END IF;
            END IF;
            IF (v_from & 7) > 0 AND (v_enemy & (1::bigint << (v_from + 7))) <> 0 THEN
                v_tg := v_tg | (1::bigint << (v_from + 7));
            END IF;
            IF (v_from & 7) < 7 AND (v_enemy & (1::bigint << (v_from + 9))) <> 0 THEN
                v_tg := v_tg | (1::bigint << (v_from + 9));
            END IF;
        ELSE
            IF (v_occ & (1::bigint << (v_from - 8))) = 0 THEN
                v_tg := v_tg | (1::bigint << (v_from - 8));
                IF v_from >= 48 AND (v_occ & (1::bigint << (v_from - 16))) = 0 THEN
                    v_tg := v_tg | (1::bigint << (v_from - 16));
                END IF;
            END IF;
            IF (v_from & 7) > 0 AND (v_enemy & (1::bigint << (v_from - 9))) <> 0 THEN
                v_tg := v_tg | (1::bigint << (v_from - 9));
            END IF;
            IF (v_from & 7) < 7 AND (v_enemy & (1::bigint << (v_from - 7))) <> 0 THEN
                v_tg := v_tg | (1::bigint << (v_from - 7));
            END IF;
        END IF;

        -- en passant: diagonal onto the ep square with a pawn of the side
        -- to move beside it. If the ep square holds an ENEMY piece it is a
        -- normal capture (handled above) and the ep branch is skipped
        -- (chess.js: "if (board[to].color === them) ... else if (to === ep)").
        -- A missing captured pawn (malformed FEN) is not rejected: chess.js
        -- accepts the move (clearing an empty square is a no-op, and
        -- make_move / move_safe handle it correctly).
        v_is_ep := v_b.ep >= 0 AND v_to = v_b.ep AND ((v_from & 7) <> (v_to & 7))
                   AND abs((v_to >> 3) - (v_from >> 3)) = 1
                   AND (v_enemy & v_tb) = 0;
        IF v_is_ep THEN
            v_tg := v_tg | v_tb;
        END IF;

        IF (v_tg & v_tb) = 0 THEN
            RETURN false;
        END IF;
        -- promotion suffix: required on the last rank, forbidden elsewhere
        IF (v_to >> 3) IN (0, 7) THEN
            IF v_promo IS NULL THEN
                RETURN false;
            END IF;
        ELSE
            IF v_promo IS NOT NULL THEN
                RETURN false;
            END IF;
        END IF;
        RETURN chess_move_safe(v_b, v_from, v_to);
    END IF;

    -- KNIGHT / BISHOP / ROOK / QUEEN: trajectory 
    v_tg := CASE v_piece
                WHEN 2 THEN chess_knight_att(v_from)
                WHEN 3 THEN chess_slider_att(v_occ, v_from, true)
                WHEN 4 THEN chess_slider_att(v_occ, v_from, false)
                ELSE chess_slider_att(v_occ, v_from, true)
                  | chess_slider_att(v_occ, v_from, false)
            END;
    IF (v_tg & v_tb) = 0 THEN
        RETURN false;
    END IF;
    RETURN chess_move_safe(v_b, v_from, v_to);
END $$;

-- Public wrapper: FEN to parsed board (ONE parse) to core. An invalid
-- FEN still raises an exception (parse_fen semantics).
CREATE OR REPLACE FUNCTION chess_validate_move(p_fen text, p_move text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
    IF p_fen IS NULL OR p_move IS NULL THEN
        RETURN false;
    END IF;
    -- cheap rejection of malformed moves before parsing FEN
    IF p_move !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' THEN
        RETURN false;
    END IF;
    RETURN chess_validate_move_b(chess_parse_fen(p_fen), p_move);
END $$;


-- 11. Insufficient material, the exact chess.js 1.4.0 isInsufficientMaterial
--     rule: K vs K; K plus one minor (either side) vs K; and all non-king
--     pieces being bishops on one square color (any count, either side).


CREATE OR REPLACE FUNCTION chess_is_insufficient_material(p_b chess_board)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
    v_minors  int;
    v_bb      bigint;
    v_sq      int;
    v_parity  int;
    v_first   int;
BEGIN
    -- pawns/rooks/queens imply sufficient material
    IF (p_b.wp | p_b.bp | p_b.wr | p_b.br | p_b.wq | p_b.bq) <> 0 THEN
        RETURN false;
    END IF;

    v_minors := chess_popcount(p_b.wn | p_b.wb | p_b.bn | p_b.bb);

    -- K vs K
    IF v_minors = 0 THEN
        RETURN true;
    END IF;
    -- K+N vs K or K+B vs K
    IF v_minors = 1 THEN
        RETURN true;
    END IF;
    -- bishops only: insufficient when all stand on one square color
    IF (p_b.wn | p_b.bn) = 0 THEN
        v_first := -1;
        v_bb := p_b.wb | p_b.bb;
        WHILE v_bb <> 0 LOOP
            v_sq := chess_lsb_index(v_bb);
            v_bb := v_bb & ~(1::bigint << v_sq);
            v_parity := ((v_sq & 7) + (v_sq >> 3)) & 1;
            IF v_first = -1 THEN
                v_first := v_parity;
            ELSIF v_parity <> v_first THEN
                RETURN false;
            END IF;
        END LOOP;
        RETURN true;
    END IF;
    RETURN false;
END $$;


-- 12. Move plus game result.
--     chess_play_move_b is the core over an already-parsed board (no
--     parse_fen): legality via chess_validate_move_b, application via
--     chess_make_move, status via chess_get_moves_b(next, true) with an
--     early exit on the first legal reply. Endings: checkmate/stalemate
--     (no legal replies), insufficient material, fifty-move rule
--     (halfmove >= 100). Threefold repetition is not detected here: the
--     function sees a single position without history.
--     chess_play_move(fen, uci) is a thin wrapper with one parse_fen.

create or replace function chess_play_move_b(p_b chess_board, p_move text)
returns chess_move_result language plpgsql immutable parallel safe as $$
declare
    v_next_b     chess_board;
    v_from       int;
    v_to         int;
    v_promo      text;
    v_new_fen    text;
    v_opp_ksq    int;
    v_is_check   boolean;
    v_moves      text[];
    v_has_moves  boolean;
    v_white_prev boolean;
begin
    if p_b is null or p_move is null then
        return (false, NULL, false, false, NULL, 'illegal_move')::chess_move_result;
    end if;
    if p_move !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
        return (false, NULL, false, false, NULL, 'illegal_move')::chess_move_result;
    end if;
    -- legality on the already-parsed board (no re-parse)
    if not chess_validate_move_b(p_b, p_move) then
        return (false, NULL, false, false, NULL, 'illegal_move')::chess_move_result;
    end if;

    v_white_prev := p_b.white_to_move;
    v_from       := chess_sq_from_name(substr(p_move, 1, 2));
    v_to         := chess_sq_from_name(substr(p_move, 3, 2));
    v_promo      := case when length(p_move) = 5 then substr(p_move, 5, 1) end;

    v_next_b  := chess_make_move(p_b, v_from, v_to, v_promo);
    v_new_fen := chess_to_fen(v_next_b);

    -- check to the king of the side to move
    if (case when v_next_b.white_to_move then v_next_b.wk else v_next_b.bk end) = 0 then
        v_is_check := false;
    else
        v_opp_ksq  := chess_bit_index(case when v_next_b.white_to_move
                                           then v_next_b.wk else v_next_b.bk end);
        v_is_check := chess_is_square_attacked(v_next_b, v_opp_ksq, v_white_prev);
    end if;

    -- whether any legal reply exists (early exit on the first)
    v_moves     := chess_get_moves_b(v_next_b, true);
    v_has_moves := (cardinality(v_moves) > 0);

    if not v_has_moves then
        if v_is_check then
            return (true, v_new_fen, true, true,
                    case when v_white_prev then '1-0' else '0-1' end,
                    'checkmate')::chess_move_result;
        else
            return (true, v_new_fen, false, true, '1/2-1/2', 'stalemate')::chess_move_result;
        end if;
    end if;

    if chess_is_insufficient_material(v_next_b) then
        return (true, v_new_fen, v_is_check, true, '1/2-1/2', 'insufficient_material')::chess_move_result;
    end if;

    if v_next_b.halfmove >= 100 then
        return (true, v_new_fen, v_is_check, true, '1/2-1/2', 'fifty_moves')::chess_move_result;
    end if;

    return (true, v_new_fen, v_is_check, false, '*', NULL)::chess_move_result;
end 
$$;

create or replace function chess_play_move(p_fen text, p_move text)
returns chess_move_result language plpgsql immutable parallel safe as $$
begin
    if p_fen is null then
        return (false, NULL, false, false, NULL, 'illegal_move')::chess_move_result;
    end if;
    return public.chess_play_move_b(chess_parse_fen(p_fen), p_move);
end $$;

-- 13. SAN over a parsed board (chess_san_b), the make_move core.
--     No parse_fen, no second play_move, no full move generation: check
--     and mate arrive as arguments (from chess_move_result) and
--     disambiguation uses popcount filtering of same-type pieces plus
--     point legality checks for candidates (as in chess_get_moves, but
--     only for the contested squares).

create or replace function chess_san_b(p_b chess_board, p_uci text,
                                       p_is_check boolean, p_is_mate boolean)
returns text language plpgsql immutable as $$
declare
    v_from      int;
    v_to        int;
    v_promo     text;
    v_from_name text;
    v_to_name   text;
    v_cand_name text;
    v_occ       bigint;
    v_piece     text;
    v_is_ep     boolean := false;
    v_capture   boolean;
    v_bb_same   bigint;
    v_sq        int;
    v_amb       int := 0;
    v_same_file boolean := true;
    v_same_rank boolean := true;
    v_disamb    text := '';
    v_res       text;
begin
    if p_b is null or p_uci is null or p_uci !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
        return p_uci;
    end if;
    v_from_name := substr(p_uci, 1, 2);
    v_to_name   := substr(p_uci, 3, 2);
    v_promo     := case when length(p_uci) = 5 then substr(p_uci, 5, 1) end;
    v_from := chess_sq_from_name(v_from_name);
    v_to   := chess_sq_from_name(v_to_name);
    v_occ  := p_b.wp|p_b.wn|p_b.wb|p_b.wr|p_b.wq|p_b.wk
            | p_b.bp|p_b.bn|p_b.bb|p_b.br|p_b.bq|p_b.bk;

    -- piece letter on the source square
    if    (p_b.wp & (1::bigint << v_from)) <> 0 then v_piece := 'p';
    elsif (p_b.wn & (1::bigint << v_from)) <> 0 then v_piece := 'n';
    elsif (p_b.wb & (1::bigint << v_from)) <> 0 then v_piece := 'b';
    elsif (p_b.wr & (1::bigint << v_from)) <> 0 then v_piece := 'r';
    elsif (p_b.wq & (1::bigint << v_from)) <> 0 then v_piece := 'q';
    elsif (p_b.wk & (1::bigint << v_from)) <> 0 then v_piece := 'k';
    elsif (p_b.bp & (1::bigint << v_from)) <> 0 then v_piece := 'p';
    elsif (p_b.bn & (1::bigint << v_from)) <> 0 then v_piece := 'n';
    elsif (p_b.bb & (1::bigint << v_from)) <> 0 then v_piece := 'b';
    elsif (p_b.br & (1::bigint << v_from)) <> 0 then v_piece := 'r';
    elsif (p_b.bq & (1::bigint << v_from)) <> 0 then v_piece := 'q';
    else v_piece := 'k';
    end if;

    -- castling
    if v_piece = 'k' and ((v_from >> 3) = (v_to >> 3))
       and abs((v_from & 7) - (v_to & 7)) = 2 then
        v_res := case when (v_to & 7) > (v_from & 7) then 'O-O' else 'O-O-O' end;
        return v_res || case when p_is_mate then '#' when p_is_check then '+' else '' end;
    end if;

    -- capture (including en passant)
    v_is_ep   := v_piece = 'p' and p_b.ep >= 0 and v_to = p_b.ep
                 and ((v_from & 7) <> (v_to & 7));
    v_capture := ((v_occ & (1::bigint << v_to)) <> 0) or v_is_ep;

    -- disambiguation: only for n/b/r/q and only when more than one piece
    -- of the same type exists (popcount filter). Candidates are OTHER
    -- squares of that piece whose move to v_to is fully legal (trajectory
    -- plus king safety, as in chess_get_moves); no full generation needed.
    if v_piece not in ('p', 'k') then
        v_bb_same := case v_piece
            when 'n' then case when p_b.white_to_move then p_b.wn else p_b.bn end
            when 'b' then case when p_b.white_to_move then p_b.wb else p_b.bb end
            when 'r' then case when p_b.white_to_move then p_b.wr else p_b.br end
            else          case when p_b.white_to_move then p_b.wq else p_b.bq end
        end;
        if chess_popcount(v_bb_same) > 1 then
            v_bb_same := v_bb_same # (1::bigint << v_from);
            while v_bb_same <> 0 loop
                v_sq := chess_lsb_index(v_bb_same);
                v_bb_same := v_bb_same & ~(1::bigint << v_sq);
                v_cand_name := chess_sq_name(v_sq);
                if chess_validate_move_b(p_b, v_cand_name || v_to_name) then
                    v_amb := v_amb + 1;
                    if substr(v_cand_name, 1, 1) = substr(v_from_name, 1, 1) then
                        v_same_file := false;   -- file alone is not enough
                    end if;
                    if substr(v_cand_name, 2, 1) = substr(v_from_name, 2, 1) then
                        v_same_rank := false;   -- rank alone is not enough
                    end if;
                end if;
            end loop;
            if v_amb > 0 then
                if v_same_file then v_disamb := substr(v_from_name, 1, 1);
                elsif v_same_rank then v_disamb := substr(v_from_name, 2, 1);
                else v_disamb := v_from_name;
                end if;
            end if;
        end if;
    end if;

    v_res := case
                when v_piece = 'p' then
                    case when v_capture then substr(v_from_name, 1, 1) else '' end
                else upper(v_piece) || v_disamb
             end
             || case when v_capture then 'x' else '' end
             || v_to_name
             || case when v_promo is not null then '=' || upper(v_promo) else '' end;

    return v_res || case when p_is_mate then '#' when p_is_check then '+' else '' end;
end 
$$;
